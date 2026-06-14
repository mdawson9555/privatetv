/**
 * Cloudflare Pages Function — CORS Stream Proxy
 * Path: /functions/proxy.js  →  handles GET /proxy?url=...
 *
 * Runs as a Cloudflare Edge Worker — no Node.js needed.
 * Rewrites HLS .m3u8 playlists so all segment URLs also go through this proxy.
 */

export async function onRequestGet(context) {
    const reqUrl = new URL(context.request.url);
    const targetUrl = reqUrl.searchParams.get('url');

    if (!targetUrl) {
        return new Response(JSON.stringify({ error: 'Missing ?url= parameter' }), {
            status: 400,
            headers: corsHeaders({ 'Content-Type': 'application/json' }),
        });
    }

    let parsedTarget;
    try {
        parsedTarget = new URL(targetUrl);
    } catch {
        return new Response(JSON.stringify({ error: 'Invalid URL' }), {
            status: 400,
            headers: corsHeaders({ 'Content-Type': 'application/json' }),
        });
    }

    // Forward request to upstream stream server
    let upstream;
    try {
        upstream = await fetch(targetUrl, {
            method: 'GET',
            headers: {
                'User-Agent':
                    'Mozilla/5.0 (SmartTV; Linux) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
                Accept: '*/*',
                'Accept-Language': 'en-US,en;q=0.9',
                Origin: parsedTarget.origin,
                Referer: parsedTarget.origin + '/',
            },
            redirect: 'follow',
        });
    } catch (err) {
        return new Response(JSON.stringify({ error: `Upstream fetch failed: ${err.message}` }), {
            status: 502,
            headers: corsHeaders({ 'Content-Type': 'application/json' }),
        });
    }

    const contentType = upstream.headers.get('content-type') || '';
    const isM3U8 =
        contentType.includes('mpegurl') ||
        contentType.includes('x-mpegurl') ||
        targetUrl.toLowerCase().includes('.m3u8') ||
        targetUrl.toLowerCase().includes('.m3u');

    if (isM3U8) {
        // Rewrite playlist: replace all stream/segment URLs with proxied versions
        const body = await upstream.text();
        const baseUrl = targetUrl.substring(0, targetUrl.lastIndexOf('/') + 1);
        const origin  = reqUrl.origin; // e.g. https://privatetv.pages.dev

        const rewritten = body
            .split('\n')
            .map(line => {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith('#')) return line;

                let resolved = trimmed;
                if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
                    resolved = baseUrl + trimmed;
                }
                return `${origin}/proxy?url=${encodeURIComponent(resolved)}`;
            })
            .join('\n');

        return new Response(rewritten, {
            status: 200,
            headers: corsHeaders({
                'Content-Type': 'application/vnd.apple.mpegurl',
                'Cache-Control': 'no-cache, no-store',
            }),
        });
    }

    // Binary passthrough (TS segments, MP4 etc.)
    const headers = corsHeaders({
        'Content-Type': contentType || 'application/octet-stream',
        'Cache-Control': upstream.headers.get('cache-control') || 'no-cache',
    });

    if (upstream.headers.get('content-length')) {
        headers['Content-Length'] = upstream.headers.get('content-length');
    }

    return new Response(upstream.body, {
        status: upstream.status,
        headers,
    });
}

// Handle OPTIONS preflight
export async function onRequestOptions() {
    return new Response(null, {
        status: 204,
        headers: corsHeaders({}),
    });
}

function corsHeaders(extra = {}) {
    return {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS, HEAD',
        'Access-Control-Allow-Headers': 'Origin, X-Requested-With, Content-Type, Accept, Range',
        'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
        ...extra,
    };
}
