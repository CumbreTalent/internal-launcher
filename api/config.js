// GET /api/config — the public Supabase settings the browser needs to sign in.
//
// The anon key is designed to be public (every Supabase web app ships it in
// its bundle); it grants nothing without a valid login, and the launcher
// itself holds no service-role key. Serving it from here keeps the HTML free
// of per-environment values, so one static page works for every deploy.

export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store')
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'Method not allowed' })
  }
  const url = process.env.SUPABASE_URL
  const anon = process.env.SUPABASE_ANON_KEY
  if (!url || !anon) {
    return res.status(500).json({ error: 'Launcher is not configured: set SUPABASE_URL and SUPABASE_ANON_KEY.' })
  }
  return res.status(200).json({ supabaseUrl: url.replace(/\/+$/, ''), supabaseAnonKey: anon })
}
