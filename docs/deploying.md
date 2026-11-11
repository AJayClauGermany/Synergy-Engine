# Deploying previews to Cloudflare

The game builds to a static folder (`dist/`). `wrangler.jsonc` deploys it as a Cloudflare
Worker with static assets, and `cloudflare/worker.ts` runs in front of every request to
ask for a password. That lets you share work-in-progress builds without making them
public.

## First time

1. Rename the Worker: change `"name"` in `wrangler.jsonc`.
2. Log in: `bunx wrangler login`.

## Try the gate locally

```bash
cp .dev.vars.example .dev.vars
```

```bash
bun run preview:local
```

Open http://localhost:8787 and enter the password from `.dev.vars`.

## Preview links per branch

Set the password all previews share (once):

```bash
bunx wrangler preview base-config secret put PREVIEW_PASSWORD
```

Deploy the current branch:

```bash
bun run preview:deploy
```

Wrangler prints a URL of the form
`https://<branch>-<worker-name>.<your-subdomain>.workers.dev`. Deploying the same branch
again updates the same link. Use `bunx wrangler preview --name demo` to pick the name
yourself, and `bunx wrangler preview delete --name demo` to remove one.

Worker Previews are in open beta in Wrangler at the time of writing; `bunx wrangler
preview --help` shows the current options.

## The main deployment

```bash
bunx wrangler secret put PREVIEW_PASSWORD
```

```bash
bun run deploy
```

It serves `https://<worker-name>.<your-subdomain>.workers.dev`, also behind the password.
When the game should be open to everyone, set `"PUBLIC_ACCESS": "true"` in
`wrangler.jsonc` and deploy again.

## How the gate behaves

- No valid session → a login page. Asset URLs are protected too, not only `index.html`.
- Correct password → a cookie valid for 7 days. It holds a token derived from the
  password, so changing the password signs everyone out.
- Scripts and agents can send the password with HTTP Basic auth (any user name):
  `curl -u x:"$PASSWORD" https://...`
- **It fails closed.** A deployment with no `PREVIEW_PASSWORD` and no
  `PUBLIC_ACCESS = "true"` serves nothing.
- Gated responses are marked `noindex` and `Cache-Control: private`.

This is one shared password, with no rate limiting. Use a long random one. To restrict by
identity instead (company email domain, single sign-on), enable Cloudflare Access for the
Worker in the Cloudflare dashboard; it works on preview URLs as well.

Because every request runs the Worker, each one counts as a Worker invocation against
your Cloudflare plan's limits.

## From GitHub Actions

`.github/workflows/preview.yml` deploys a preview named `pr-<number>` for each pull
request. It is off until you:

1. add repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`,
2. add a repository variable `CLOUDFLARE_PREVIEWS` set to `true`,
3. set the shared preview password as shown above.

## Build-time configuration

Only environment variables starting with `PUBLIC_` are compiled into the bundle (for
example `PUBLIC_CONVEX_URL`). They are visible to anyone who can open the game, so never
put a secret in one.
