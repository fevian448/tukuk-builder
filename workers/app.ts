import { createRequestHandler, RouterContextProvider, type ServerBuild } from 'react-router';

declare global {
  interface CloudflareEnvironment extends Env {}
}

const requestHandler = createRequestHandler(
  // The virtual module resolves to the generated server build; the cast bridges the
  // ambient declaration in `types/` to the `ServerBuild` shape the handler expects.
  () => import('virtual:react-router/server-build') as unknown as Promise<ServerBuild>,
  import.meta.env.MODE,
);

export default {
  async fetch(request, env, ctx) {
    const context = new RouterContextProvider() as RouterContextProvider & {
      cloudflare: { env: Env; ctx: ExecutionContext };
    };

    context.cloudflare = { env, ctx };

    const response = await requestHandler(request, context);

    /*
     * Percepatkan lawatan berulang ke build.tukuk.org. Shell HTML adalah generik
     * (projek dimuat daripada IndexedDB di pelayar), jadi ia boleh di-cache di POP
     * Cloudflare: TTL pendek + stale-while-revalidate supaya pelawat menerima shell
     * serta-merta sambil tepi muat semula secara latar belakang. HANYA GET, status
     * 200, jenis `text/html`, dan BUKAN `/api/*` (chat/SSE/API kekal dinamik).
     */
    const isApi = new URL(request.url).pathname.startsWith('/api/');
    const contentType = response.headers.get('content-type') || '';
    if (request.method === 'GET' && response.status === 200 && contentType.includes('text/html') && !isApi) {
      const headers = new Headers(response.headers);
      headers.set('Cache-Control', 'public, max-age=30, s-maxage=300, stale-while-revalidate=3600');
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    }

    return response;
  },
} satisfies ExportedHandler<CloudflareEnvironment>;