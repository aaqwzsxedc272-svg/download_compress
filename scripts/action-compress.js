#!/usr/bin/env node
/**
 * Compress one link without a web server: resolve → download → encode → upload.
 *
 * This is the engine behind .github/workflows/compress.yml, but it runs anywhere
 * Node runs, so it is easy to test:
 *
 *   node scripts/action-compress.js --url https://pixeldrain.com/u/xxxx --preset small
 *   node scripts/action-compress.js --issue-body-file issue.md --out out
 *
 * It exits non-zero with a readable message when a hop fails, and writes a
 * Markdown report to $GITHUB_STEP_SUMMARY when that variable is set.
 */
'use strict';

const fsp = require('node:fs/promises');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { resolve, directUrl } = require('../shared/resolve');
const sources = require('../server/sources');
const { probe, transcode } = require('../server/ffmpeg');
const { getPreset, buildPlan, targetTooSmall, PRESET_LIST } = require('../server/compress');
const hosters = require('../server/hosters');

const MAX_BYTES = (Number(process.env.MAX_UPLOAD_MB) || 6144) * 1024 * 1024;

/* --------------------------------------------------------------- arguments */

function readArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = true;
    }
  }
  return out;
}

/** Pull the fields out of a GitHub issue form body ("### Link\n\n<url>"). */
function parseIssueBody(body) {
  const fields = {};
  const lines = String(body || '').split(/\r?\n/);
  let key = null;
  for (const line of lines) {
    const header = /^###\s+(.*)$/.exec(line.trim());
    if (header) {
      key = header[1].trim().toLowerCase();
      fields[key] = '';
      continue;
    }
    if (key && line.trim() && !line.trim().startsWith('_No response_')) {
      fields[key] = fields[key] ? `${fields[key]}\n${line.trim()}` : line.trim();
    }
  }

  const urlMatch = String(body || '').match(/https?:\/\/[^\s)>\]]+/);
  const qualityKey = Object.keys(fields).find((k) => /quality|preset/.test(k));
  const fitKey = Object.keys(fields).find((k) => /fit|target|max.*mb/.test(k));
  const fitMatch = fitKey && fields[fitKey].match(/(\d+(?:\.\d+)?)/);

  return {
    url: urlMatch ? urlMatch[0] : '',
    preset: qualityKey ? fields[qualityKey] : '',
    targetMb: fitMatch ? Number(fitMatch[1]) : 0,
  };
}

/** "High quality" / "balanced" / "Small (720p)" → a preset id. */
function matchPreset(text, fallback) {
  const wanted = String(text || '').trim().toLowerCase();
  if (!wanted) return fallback;
  const exact = PRESET_LIST.find((p) => p.id === wanted || p.label.toLowerCase() === wanted);
  if (exact) return exact.id;
  const loose = PRESET_LIST.find((p) => wanted.includes(p.id) || wanted.includes(p.label.toLowerCase().split(' ')[0]));
  return loose ? loose.id : fallback;
}

function human(bytes) {
  if (!bytes) return '0 MB';
  return `${(bytes / 1048576).toFixed(bytes > 10485760 ? 0 : 2)} MB`;
}

/* --------------------------------------------------------------------- main */

async function main() {
  const args = readArgs(process.argv.slice(2));

  let issueBody = '';
  if (typeof args['issue-body'] === 'string') issueBody = args['issue-body'];
  else if (typeof args['issue-body-file'] === 'string') {
    issueBody = await fsp.readFile(args['issue-body-file'], 'utf8').catch(() => '');
  }
  const fromIssue = parseIssueBody(issueBody);

  const url = String(args.url || fromIssue.url || '').trim();
  if (!url) throw Object.assign(new Error('No link was given.'), { code: 'NO_URL' });

  const presetId = matchPreset(args.preset || fromIssue.preset, 'high');
  const preset = getPreset(presetId);
  const targetMb = Number(args['target-mb'] || fromIssue.targetMb) || 0;

  const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'squeeze-'));
  const outDir = path.resolve(String(args.out || 'out'));
  await fsp.mkdir(outDir, { recursive: true });

  const sourcePath = path.join(workDir, 'source');
  const outputPath = path.join(outDir, 'compressed.mp4');
  const report = { url, preset: preset.id, targetMb, steps: [] };
  const step = (text) => {
    report.steps.push(text);
    console.log(`[squeeze] ${text}`);
  };

  try {
    /* 1. What is behind the link? */
    step('Resolving the link…');
    let resolved = await resolve(url).catch((err) => {
      throw Object.assign(new Error(`Could not read that link: ${err.message}`), { code: err.code || 'RESOLVE_FAILED' });
    });

    if (!resolved) {
      step('Not a known share host — probing it directly…');
      const remote = await sources.probeRemote(url);
      if (remote.reachable && !remote.isHtml) {
        resolved = {
          resolver: 'direct',
          files: [{ name: 'video', kind: 'video', ref: { resolver: 'direct', url, name: 'video' } }],
        };
      } else if (remote.isHtml) {
        throw Object.assign(new Error('That link is a web page, and no video was found on it.'), { code: 'NO_VIDEO_FOUND' });
      } else {
        throw Object.assign(
          new Error(`That host did not answer (${remote.error || 'unreachable'}). It may be bot-protected or down.`),
          { code: 'UNREACHABLE' },
        );
      }
    }

    const file = resolved.files.find((f) => f.kind === 'video') || resolved.files[0];
    if (!file) throw Object.assign(new Error('No video was found behind that link.'), { code: 'NO_VIDEO_FOUND' });
    report.title = resolved.title || file.name || null;
    report.resolver = resolved.resolver;
    step(`Found a file via the ${resolved.resolver} resolver: ${file.name || 'video'}`);

    /* 2. Download it. */
    step('Downloading…');
    if (file.ref && file.ref.resolver === 'platform') {
      await sources.downloadPlatform(file.ref.url || url, workDir);
      await fsp.rename(path.join(workDir, 'source'), sourcePath).catch(async () => {
        const entries = await fsp.readdir(workDir);
        const found = entries.find((f) => /\.(mp4|mkv|webm|mov|m4v)$/i.test(f));
        if (found) await fsp.rename(path.join(workDir, found), sourcePath);
      });
    } else {
      const direct = await directUrl(file.ref);
      await sources.downloadHttp(direct, sourcePath, {
        maxBytes: MAX_BYTES,
        onProgress: (received, total) => {
          if (total && received / total > 0 && Math.round((received / total) * 100) % 25 === 0) {
            process.stdout.write(`\r[squeeze] downloaded ${Math.round((received / total) * 100)}%   `);
          }
        },
      });
      process.stdout.write('\n');
    }

    const sourceStat = await fsp.stat(sourcePath);
    report.sourceBytes = sourceStat.size;
    step(`Downloaded ${human(sourceStat.size)}`);

    /* 3. Encode. */
    step(`Compressing with the "${preset.label}" preset…`);
    const meta = await probe(sourcePath);
    if (!meta || !meta.duration) throw Object.assign(new Error('That file is not a readable video.'), { code: 'BAD_MEDIA' });
    if (targetMb && targetTooSmall(meta, preset, targetMb)) {
      step(`Heads up: ${targetMb} MB is very tight for a ${Math.round(meta.duration)}s clip — quality will suffer.`);
    }

    const plan = buildPlan({
      input: sourcePath,
      output: outputPath,
      meta,
      preset,
      targetMb,
      passlogBase: path.join(workDir, 'x264pass'),
    });

    for (const pass of plan.passes) {
      await transcode(sourcePath, outputPath, pass.args, {
        duration: meta.duration,
        onProgress: ({ seconds }) => {
          if (meta.duration && seconds != null) {
            process.stdout.write(`\r[squeeze] encoding ${Math.min(100, Math.round((seconds / meta.duration) * 100))}%   `);
          }
        },
      });
    }
    process.stdout.write('\n');

    let outStat = await fsp.stat(outputPath);
    if (!outStat.size) throw Object.assign(new Error('Compression produced an empty file.'), { code: 'EMPTY_OUTPUT' });

    let usedOriginal = false;
    if (!targetMb && outStat.size >= sourceStat.size) {
      await fsp.copyFile(sourcePath, outputPath);
      outStat = await fsp.stat(outputPath);
      usedOriginal = true;
      step('Re-encoding would have made it bigger, so the original bytes are what gets shared.');
    }

    report.outputBytes = outStat.size;
    report.savedPct = sourceStat.size ? Math.round((1 - outStat.size / sourceStat.size) * 100) : 0;
    report.outputPath = outputPath;
    step(`Compressed ${human(sourceStat.size)} → ${human(outStat.size)} (${report.savedPct >= 0 ? '−' : '+'}${Math.abs(report.savedPct)}%)`);

    /* 4. Upload it so there is a link to hand back. */
    if (!args['no-upload']) {
      step('Uploading to a file host…');
      try {
        const hosted = await hosters.uploadToHoster(outputPath, { name: 'compressed.mp4' }, {});
        report.shareUrl = hosted.url;
        report.provider = hosted.provider;
        step(`Share link ready: ${hosted.url}`);
      } catch (err) {
        report.hostError = err.message;
        step(`Upload failed (${err.message}). The file is still attached below as a download.`);
      }
    }
  } finally {
    await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }

  /* 5. Report. */
  const markdown = [
    '## Squeeze result',
    '',
    report.shareUrl ? `**Share link:** ${report.shareUrl}` : '**Share link:** not created',
    '',
    `| | |`,
    `| --- | --- |`,
    `| Source | ${report.url} |`,
    `| Preset | ${report.preset}${report.targetMb ? ` · fit in ${report.targetMb} MB` : ''} |`,
    `| Size | ${human(report.sourceBytes)} → ${human(report.outputBytes)} (${report.savedPct >= 0 ? '−' : '+'}${Math.abs(report.savedPct || 0)}%) |`,
    report.outputPath ? `| File | \`${path.basename(report.outputPath)}\` (attached to this run) |` : '',
    report.hostError ? `| Host error | ${report.hostError} |` : '',
    '',
    '<details><summary>Steps</summary>',
    '',
    ...report.steps.map((s) => `- ${s}`),
    '',
    '</details>',
  ]
    .filter(Boolean)
    .join('\n');

  console.log('\n' + markdown);
  if (process.env.GITHUB_STEP_SUMMARY) {
    await fsp.appendFile(process.env.GITHUB_STEP_SUMMARY, markdown + '\n').catch(() => {});
  }
  if (process.env.GITHUB_OUTPUT) {
    await fsp
      .appendFile(
        process.env.GITHUB_OUTPUT,
        `share_url=${report.shareUrl || ''}\noutput=${report.outputPath || ''}\nsummary<<EOF\n${markdown}\nEOF\n`,
      )
      .catch(() => {});
  }
  return report;
}

if (require.main === module) {
  main().catch((err) => {
    const message = err && err.message ? err.message : String(err);
    console.error(`\n[squeeze] FAILED: ${message}`);
    const why = {
      RESOLVE_FAILED: 'The share page could not be read — the host may be bot-protected or changed its layout.',
      UNREACHABLE: 'This machine could not reach that host. GitHub runners have full internet, so the host itself is refusing.',
      NO_VIDEO_FOUND: 'The link is a page without a video file on it, or the video is behind a player that needs a browser.',
      BLOCKED_HOST: 'That address is internal and deliberately blocked.',
      NO_YTDLP: 'yt-dlp is missing — platform links need it.',
    }[err.code];
    if (why) console.error(`[squeeze] ${why}`);
    if (process.env.GITHUB_STEP_SUMMARY) {
      fs.appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `## Squeeze failed\n\n${message}\n\n${why || ''}\n`,
      );
    }
    process.exit(1);
  });
}

module.exports = { parseIssueBody, matchPreset };
