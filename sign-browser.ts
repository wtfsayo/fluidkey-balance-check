// stdout carries only the signature; the link the user opens goes to stderr.
const request: { address: string; message: string } = await Bun.stdin.json();

const token = crypto.randomUUID();
const page = (await Bun.file(new URL("sign.html", import.meta.url)).text()).replace("__REQUEST__", JSON.stringify(request));
const { promise: signature, resolve } = Promise.withResolvers<string>();
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(incoming) {
    if (new URL(incoming.url).searchParams.get("token") !== token) return new Response(null, { status: 404 });
    if (incoming.method === "POST") {
      resolve(await incoming.text());
      return new Response(null, { status: 204 });
    }
    return new Response(page, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  },
});
console.error(
  `Open this page in the browser that has your wallet, and approve the signature:\n  http://127.0.0.1:${server.port}/?token=${token}`,
);
process.stdout.write(await signature);
await server.stop();
