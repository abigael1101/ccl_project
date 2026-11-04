const VISITOR_COOKIE = 'mbr_visitor_session';

function getVisitorToken(request: Request): string | null {
  const cookie = (request.headers.get('cookie') || '')
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${VISITOR_COOKIE}=`));
  const token = cookie?.slice(VISITOR_COOKIE.length + 1);
  return token && /^[A-Za-z0-9_-]{40,50}$/.test(token) ? token : null;
}

function loginRedirect(request: Request): Response {
  return new Response(null, {
    status: 302,
    headers: {
      'Cache-Control': 'no-store',
      Location: new URL('/Login.html', request.url).toString()
    }
  });
}

export default async (request: Request, context: { next: () => Promise<Response> }) => {
  const url = new URL(request.url);
  if (url.pathname.startsWith('/api/')
    || url.pathname === '/Login.html'
    || url.pathname.startsWith('/.netlify/')
    || !/\.html?$/i.test(url.pathname) && url.pathname !== '/') {
    return context.next();
  }

  const token = getVisitorToken(request);
  if (!token) {
    return loginRedirect(request);
  }

  const supabaseUrl = Netlify.env.get('SUPABASE_URL');
  const serviceKey = Netlify.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceKey) {
    return new Response('Authentication is not configured for this site.', {
      status: 503,
      headers: { 'Cache-Control': 'no-store' }
    });
  }

  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  const tokenHash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  const query = new URLSearchParams({
    token_hash: `eq.${tokenHash}`,
    expires_at: `gt.${new Date().toISOString()}`,
    select: 'token_hash',
    limit: '1'
  });
  const verification = await fetch(`${supabaseUrl.replace(/\/$/, '')}/rest/v1/visitor_sessions?${query}`, {
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`
    }
  });

  if (!verification.ok) {
    return new Response('Unable to verify sign-in right now. Please try again later.', {
      status: 503,
      headers: { 'Cache-Control': 'no-store' }
    });
  }
  const sessions = await verification.json();
  if (!Array.isArray(sessions) || sessions.length === 0) {
    return loginRedirect(request);
  }

  const response = await context.next();
  response.headers.set('Cache-Control', 'private, no-store');
  return response;
};
