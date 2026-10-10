# Termux/Android

Local development notes for running this repo on Termux. Nothing in `src/` or
the deploy path depends on them.

## Running workerd

The `workerd` npm package ships glibc builds and rejects
`process.platform === "android"`. This host has `glibc-runner`, so
[`scripts/workerd-android.sh`](./scripts/workerd-android.sh):

1. downloads `@cloudflare/workerd-linux-arm64` with `npm pack`,
2. patches the binary to Termux's glibc loader/rpath with `patchelf` (via `grun`),
3. replaces `bin/workerd` with a `grun` wrapper so Node can spawn it,
4. adds the `android arm64 LE` platform key to the `workerd` package.

```sh
pkg install glibc-runner nodejs-lts
npm install
bash scripts/workerd-android.sh   # re-run after every npm install
npm run cf-typegen
npm test
```

This also makes `wrangler` usable: `wrangler types`, `wrangler dev`,
`wrangler deploy`, `wrangler deploy --dry-run`.

## TLS trust for real egress

Workerd's glibc process does not read the Termux CA store by default, so real
outbound HTTPS fails with `unable to get local issuer certificate`. The wrapper
sets `SSL_CERT_FILE` to `$PREFIX/etc/tls/cert.pem` unless already set.
