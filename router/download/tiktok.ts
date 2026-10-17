import { Request, Response } from 'express';
import axios, { type AxiosRequestConfig } from 'axios';
import crypto from 'crypto';
import { HttpsProxyAgent } from 'https-proxy-agent';
import FormData from 'form-data';

type HttpsProxyAgentInstance = InstanceType<typeof HttpsProxyAgent>;

interface ProxyEntry {
  str: string;
  agent: HttpsProxyAgentInstance;
}

interface RawSegment {
  start: number;
  end: number;
  timestamp: string;
  text: string;
  speaker?: string;
}

interface CleanSegment {
  start: number;
  end: number;
  timestamp: string;
  text: string;
  speaker?: string;
}

interface VideoMeta {
  source: string;
  id: string;
  title: string;
  cover: string;
  duration: number;
  stats: Record<string, number>;
  author: {
    handle: string;
    name: string;
    avatar: string;
  };
}

interface ApiResponse {
  success?: boolean;
  ok?: boolean;
  id?: string;
  status?: string;
  guest_token?: string;
  text?: string;
  segments?: RawSegment[];
  meta?: VideoMeta;
  [key: string]: unknown;
}

interface TranscribeResult {
  status: true;
  creator: string;
  runtime: string;
  proxy_used: string;
  meta: VideoMeta;
  transcript: {
    full_text: string;
    total_segments: number;
    segments: CleanSegment[];
  };
}

// ==================== KONFIG ====================
const BASE_URL = 'https://transcriptik.com/wp-admin/admin-ajax.php';
const PROXY_API = 'https://api.ikyyxd.my.id/v2l/proxy-free/ikyy-xsample';
const STATIC_NONCE = '0ebdcaadc3';
const REQUEST_TIMEOUT = 60_000;

let proxies: ProxyEntry[] = [];
let proxiesLoaded = false;

// ✅ FIX: pakai block body supaya return type void konsisten
const log = (...args: unknown[]): void => {
  process.stderr.write(`[LOG] ${args.join(' ')}\n`);
};

const baseHeaders: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Mobile Safari/537.36',
  Accept: '*/*',
  'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
  'Sec-Ch-Ua': '"Chromium";v="139", "Not;A=Brand";v="99"',
  'Sec-Ch-Ua-Mobile': '?1',
  'Sec-Ch-Ua-Platform': '"Android"',
  Origin: 'https://transcriptik.com',
  Referer: 'https://transcriptik.com/',
  'X-Requested-With': 'XMLHttpRequest',
};

// ==================== PROXY ====================
async function fetchProxies(): Promise<void> {
  try {
    log('Fetching authenticated proxies...');
    const { data } = await axios.get<string[]>(PROXY_API, { timeout: 8000 });

    if (!Array.isArray(data)) throw new Error('Invalid proxy list format');

    proxies = data
      .filter((p): p is string => typeof p === 'string')
      .filter((p) => {
        const parts = p.split(':');
        return parts.length === 4 && !isNaN(Number(parts[1]));
      })
      .map((p) => {
        const [host, port, user, pass] = p.split(':');
        const agent: HttpsProxyAgentInstance = new HttpsProxyAgent({
          host,
          port: parseInt(port, 10),
          auth: `${user}:${pass}`,
          protocol: 'http:',
        });
        return { str: p, agent };
      });

    if (proxies.length === 0) throw new Error('No valid proxies found');
    proxiesLoaded = true;
    log(`✓ Loaded ${proxies.length} authenticated proxies.`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Proxy fetch failed: ${msg}`);
  }
}

async function ensureProxies(): Promise<void> {
  if (!proxiesLoaded || proxies.length === 0) {
    await fetchProxies();
  }
}

function getRandomProxyAgent(): HttpsProxyAgentInstance | null {
  if (proxies.length === 0) return null;
  const p = proxies[Math.floor(Math.random() * proxies.length)];
  if (!p) return null;
  log(`Using Proxy: ${p.str}`);
  return p.agent;
}

function getProxyLabel(agent: HttpsProxyAgentInstance | null): string {
  if (!agent) return 'DIRECT';
  // @ts-expect-error - proxy host/port tidak di-expose di tipe publik
  const { host, port } = agent.proxy ?? {};
  return host && port ? `${host}:${port}` : 'UNKNOWN';
}

// ==================== PROFILE ====================
function generateProfile(): string {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  return JSON.stringify({
    os: 'android',
    size: [360, 800] as [number, number],
    zone: timeZone,
  });
}

// ==================== HTTP HELPER ====================
function buildConfig(
  agent: HttpsProxyAgentInstance | null,
  extraHeaders: Record<string, string> = {}
): AxiosRequestConfig {
  return {
    headers: { ...baseHeaders, ...extraHeaders },
    httpsAgent: agent ?? undefined,
    httpAgent: agent ?? undefined,
    timeout: REQUEST_TIMEOUT,
  };
}

// ==================== API CALLS ====================
async function guestBootstrap(
  cid: string,
  agent: HttpsProxyAgentInstance | null
): Promise<string> {
  const formData = new FormData();
  formData.append('action', 'ttt_guest_bootstrap');
  formData.append('nonce', STATIC_NONCE);
  formData.append('cid', cid);
  formData.append('profile', generateProfile());
  formData.append('guest_token', '');

  const headers = { ...baseHeaders };
  delete headers['Content-Type'];

  const cfg = buildConfig(agent, headers);

  try {
    const { data } = await axios.post<ApiResponse>(BASE_URL, formData, cfg);
    if (data.success && data.guest_token) return data.guest_token;
    throw new Error(
      `Bootstrap failed: ${JSON.stringify(data).substring(0, 150)}`
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`[!] Bootstrap attempt failed (${msg}), retrying...`);
    await new Promise((r) => setTimeout(r, 1000));

    const { data } = await axios.post<ApiResponse>(BASE_URL, formData, cfg);
    if (data.success && data.guest_token) return data.guest_token;
    throw new Error('Bootstrap failed after retries.');
  }
}

async function checkUrl(
  videoUrl: string,
  cid: string,
  guestToken: string,
  agent: HttpsProxyAgentInstance | null
): Promise<ApiResponse> {
  const params = new URLSearchParams({
    action: 'ttt_check',
    nonce: STATIC_NONCE,
    video_url: videoUrl,
    cid,
    guest_token: guestToken,
  });

  const { data } = await axios.post<ApiResponse>(
    BASE_URL,
    params.toString(),
    buildConfig(agent, {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    })
  );
  return data;
}

async function initTranscribe(
  videoUrl: string,
  cid: string,
  guestToken: string,
  agent: HttpsProxyAgentInstance | null
): Promise<ApiResponse> {
  const requestId = crypto.randomUUID();

  const params = new URLSearchParams({
    action: 'ttt_transcribe_init',
    request_id: requestId,
    nonce: STATIC_NONCE,
    video_url: videoUrl,
    cid,
    guest_token: guestToken,
  });

  const { data } = await axios.post<ApiResponse>(
    BASE_URL,
    params.toString(),
    buildConfig(agent, {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    })
  );
  return data;
}

async function pollTranscribe(
  jobId: string,
  cid: string,
  guestToken: string,
  agent: HttpsProxyAgentInstance | null
): Promise<ApiResponse> {
  const params = new URLSearchParams({
    action: 'ttt_transcribe_poll',
    nonce: STATIC_NONCE,
    id: jobId,
    cid,
    guest_token: guestToken,
  });

  const { data } = await axios.post<ApiResponse>(
    BASE_URL,
    params.toString(),
    buildConfig(agent, {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    })
  );
  return data;
}

// ==================== MAIN LOGIC ====================
async function transcribeTikTok(
  videoUrl: string,
  maxRetries = 5
): Promise<TranscribeResult> {
  const start = Date.now();

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const cid = crypto.randomUUID();
    log(
      `\n[=== Attempt ${attempt}/${maxRetries} | CID: ${cid.substring(0, 8)}... ===]`
    );

    try {
      const agent = getRandomProxyAgent();

      log('[*] Bootstrapping guest session...');
      const guestToken = await guestBootstrap(cid, agent);
      log(`[*] Guest Token acquired: ${guestToken.substring(0, 20)}...`);

      log('[*] Checking TikTok video meta...');
      const checkRes = await checkUrl(videoUrl, cid, guestToken, agent);

      if (!checkRes.ok || !checkRes.meta) {
        throw new Error(
          `Check failed: ${JSON.stringify(checkRes).substring(0, 150)}`
        );
      }

      const meta = checkRes.meta;
      log(`[*] Video Found: "${meta.title}" by @${meta.author.handle}`);

      log('[*] Initializing transcription job...');
      const initRes = await initTranscribe(videoUrl, cid, guestToken, agent);

      if (!initRes.success || !initRes.id) {
        throw new Error(
          `Init failed: ${JSON.stringify(initRes).substring(0, 150)}`
        );
      }

      const jobId = initRes.id;
      log(`[*] Job ID: ${jobId}, Status: ${initRes.status}`);

      let result: ApiResponse | undefined;
      let pollAttempts = 0;
      const maxPoll = 30;

      while (pollAttempts < maxPoll) {
        await new Promise((r) => setTimeout(r, 3000));
        result = await pollTranscribe(jobId, cid, guestToken, agent);

        if (result.status === 'completed') break;
        if (result.status === 'failed')
          throw new Error('Transcription job failed on server.');

        log(`    Polling... Status: ${result.status}`);
        pollAttempts++;
      }

      if (result?.status !== 'completed') {
        throw new Error('Polling timeout or incomplete status.');
      }

      const cleanSegments: CleanSegment[] = (result.segments ?? []).map(
        (seg) => ({
          start: seg.start,
          end: seg.end,
          timestamp: seg.timestamp,
          text: seg.text,
          speaker: seg.speaker,
        })
      );

      return {
        status: true,
        creator: 't.me/IkyyExecutive',
        runtime: `${Date.now() - start} ms`,
        proxy_used: getProxyLabel(agent),
        meta: {
          source: meta.source,
          id: meta.id,
          title: meta.title,
          cover: meta.cover,
          duration: meta.duration,
          stats: meta.stats,
          author: {
            handle: meta.author.handle,
            name: meta.author.name,
            avatar: meta.author.avatar,
          },
        },
        transcript: {
          full_text: result.text ?? '',
          total_segments: cleanSegments.length,
          segments: cleanSegments,
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`[!] Attempt ${attempt} failed: ${msg}`);
      if (attempt === maxRetries) {
        throw new Error(`Exceeded maximum retries (${maxRetries}).`);
      }
      log('[*] Switching proxy and retrying...');
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  throw new Error('Unexpected: transcribe loop exited.');
}

// ==================== EXPRESS HANDLER ====================
export default async function tiktokHandler(req: Request, res: Response) {
  const url = (req.query.url || req.body?.url) as string | undefined;

  if (!url) {
    return res.status(400).json({
      status: false,
      message: 'URL required',
    });
  }

  try {
    await ensureProxies();

    const result = await transcribeTikTok(url, 5);
    return res.json({
      status: true,
      data: result,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return res.status(500).json({
      status: false,
      message: msg,
    });
  }
}