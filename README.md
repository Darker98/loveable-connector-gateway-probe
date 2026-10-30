# gateway-probe

Fault-injection REST API for observing how Lovable's connector gateway handles failures.
Zero dependencies, Node >= 18. The server is only half the experiment: the other half is
the code the Lovable agent writes against it.

## Run / deploy

```
node server.js                      # local, :3000
node selftest.js                    # verifies the probe itself (not Lovable)
docker build -t gateway-probe . && docker run -p 3000:3000 gateway-probe
```

Env vars (namespaced on purpose):

| Var | Default | Purpose |
|---|---|---|
| `PROBE_API_KEY` | `lovable-test-key` | The credential `/scenario/auth/*` accepts (`Authorization: Bearer <key>` or `X-API-Key: <key>`). Set this in the Lovable custom connector. |
| `PROBE_ADMIN_TOKEN` | *(empty = open)* | Protects `/_admin/*`. **Set it on any public deploy.** |
| `PORT` | `3000` | |

State (attempt counters, log) is in memory. A restart or redeploy wipes it; stdout also carries one JSON line per request.

## Endpoints

All under `/scenario/*`, any HTTP method (so retry-on-POST vs GET can be compared).
`?key=<id>` isolates the attempt counter, so use a **fresh key per test run**. Attempt 1 is the first request that reaches the server, attempt 2 is a retry, and so on.

| Test | Endpoint | Behaviour |
|---|---|---|
| 1. 429 | `/scenario/rate-limit?key=K&fail=N&retryAfter=S` | First N attempts get 429, then 200. `fail=all` = always 429. `retryAfter` = seconds (default 1), `date` (HTTP-date), or `none`. |
| 2. 5xx | `/scenario/5xx/{500,502,503,504}?key=K&fail=N` | First N attempts get the status, then 200. `fail=all` = always. Optional `retryAfter` as above. |
| 3. Timeout | `/scenario/timeout?key=K&ms=N` | Replies 200 after N ms. `ms=hang` never replies. If the caller disconnects, the log records `aborted` and `elapsedMs`, which is the gateway's effective time limit. |
| 4. Vendor 4xx | `/scenario/4xx/{400,402,404,409,410,418,422}?key=K` | Fixed JSON body `{error:{code:"VENDOR_<status>",...}}` plus `X-Vendor-Error` header, to see what survives the gateway. 422 adds a `fields` array. |
| 5. Auth | `/scenario/auth/protected` | 401 `MISSING_CREDENTIALS` (+`WWW-Authenticate`) when no credential reaches us, 401 `INVALID_CREDENTIALS` if wrong, 200 if right. |
| | `/scenario/auth/forbidden` | Valid key but always 403 `INSUFFICIENT_SCOPE`. |
| | `/scenario/auth/expired?fail=N` | Valid key, but first N attempts get 401 `TOKEN_EXPIRED`, then 200. Does the gateway retry on 401? |
| | `/scenario/echo` | 200 with the headers/query/body we received (secrets truncated). Shows exactly what the gateway injects, strips or adds. |

Admin: `GET /_admin/log[?key=K&scenario=S]`, `GET /_admin/reset` (append `token=` if `PROBE_ADMIN_TOKEN` is set).

## Reading results

```
node report.js https://<your-host> <adminToken> [key]
```

Prints each attempt per scenario/key with the gap to the previous one, final status, and whether the caller hung up. That gives:

- **Retry count and backoff**: number of attempts and the `+gap` column (compare against `Retry-After`).
- **Timeout**: `ABORTED by caller after N ms` on the `hang` scenario. Compare against what the app saw (error text, elapsed time).
- **User-Agent / headers** on each attempt: proves the call came via the gateway, and whether retries are the gateway's or the app's.

## Test matrix

Run each from the Lovable app and record (a) what the app received, (b) what `report.js` shows.
To separate gateway retries from retries the agent wrote, **tell the agent not to add its own retry/timeout logic** (or read its code first).

| # | Call (fresh key each) | Question | Look at |
|---|---|---|---|
| 1a | `rate-limit?fail=1&retryAfter=2` | Retried? Waited >= 2 s? App ends with 200? | attempts, gap |
| 1b | `rate-limit?fail=all&retryAfter=1` | How many retries before giving up? What does the app get (429? 502? wrapped?) | attempt count, app status/body |
| 1c | `rate-limit?fail=1&retryAfter=date` / `none` | Is the date form honoured? Default backoff when absent? | gap |
| 1d | 1a via POST | Are non-idempotent methods retried? | attempt count |
| 2a | `5xx/503?fail=1` | Retried? | attempts |
| 2b | `5xx/{500,502,504}?fail=all` | Which codes are retried? How many times? What status/body reaches the app? | attempts, app response |
| 2c | 2a via POST | Retried on POST? | attempts |
| 3a | `timeout?ms=10000` / `30000` / `60000` | At what point does the gateway give up (or does it)? | `elapsedMs`, aborted |
| 3b | `timeout?ms=hang` | Max wait; what the app receives; is the call retried after a timeout? | aborted, attempt count |
| 4  | `4xx/{400,404,409,418,422}` | Status preserved as-is, or remapped (e.g. to 502/500)? Body and `X-Vendor-Error` header preserved? Retried? | app response, attempts |
| 5a | `auth/protected` with connector credential unset / wrong | What does the app get when no credential reaches us? Is it 401 from the vendor, or an error from the gateway before reaching us? | whether the request appears in the log at all |
| 5b | `auth/protected` with right key | Which header does the gateway send the key in? | `echo` headers |
| 5c | `auth/forbidden` | 403 passed through? | app response |
| 5d | `auth/expired?fail=1` | Is a 401 retried / treated as credential refresh? | attempts |
| 5e | Call the app's gateway route with no Lovable session | Is the gateway itself unauthenticated-callable? (Check from outside the app.) | HTTP status |

A request that never shows in `report.js` was rejected or short-circuited before the gateway forwarded it. That is itself a result for 5a/5e.

## Suggested prompt for the Lovable agent

> Using the "gateway-probe" custom connector, build a small page with one button per
> scenario below. Each button calls the connector through a server function and shows
> the HTTP status, response body, headers, and elapsed time it got back. Use the
> connector as documented. Do not add your own retries, timeouts, or error remapping;
> just surface what the connector returns. Each scenario takes a `key` query parameter
> that I will change per run (add a text input for it).
>
> Scenarios (all under `/scenario`): `rate-limit?fail=1&retryAfter=2`,
> `rate-limit?fail=all`, `5xx/503?fail=1`, `5xx/500?fail=all`, `5xx/502?fail=all`,
> `5xx/504?fail=all`, `timeout?ms=10000`, `timeout?ms=60000`, `timeout?ms=hang`,
> `4xx/400`, `4xx/404`, `4xx/409`, `4xx/422`, `auth/protected`, `auth/forbidden`,
> `auth/expired?fail=1`, `echo`.

Then run a second pass without the "no own retries" instruction, e.g. "make this robust", to see what the agent adds on its own, and re-run the matrix.

## Notes / caveats

- The Lovable connector UI/field names weren't verified here. Configure the connector with the deployed base URL and `PROBE_API_KEY` as the credential, in whatever form it offers (bearer or header).
- Behaviour may differ by method, so the matrix repeats 1a and 2a as POST.
- A platform in front of the probe (Render, Cloudflare, etc.) can add its own timeouts and 502/504s. Prefer a host with no proxy timeout under ~2 min, or note the host's limit before reading the `timeout` results.
