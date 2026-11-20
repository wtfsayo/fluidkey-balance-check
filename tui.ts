import {
  assetLines,
  chainLines,
  headline,
  type Line,
  noteLines,
  profileLines,
  safeLines,
  type ScanState,
  statusLine,
  summarize,
} from "./report";

const VIEWS = ["Overview", "Safes"];
const HEADER_ROWS = 5;
const color = !process.env.NO_COLOR;
const STYLE: Record<NonNullable<Line["kind"]>, string> = {
  title: "\x1b[1m",
  head: "\x1b[2m",
  dim: "\x1b[2m",
  warn: color ? "\x1b[33m" : "",
  bad: color ? "\x1b[31m" : "\x1b[1m",
};

export type Tui = { refresh: () => void; closed: Promise<void> };

/** Full-screen view of `state`, which the caller keeps mutating. Nothing is drawn until `refresh`. */
export function openTui(state: ScanState): Tui {
  const { promise: closed, resolve } = Promise.withResolvers<void>();
  let view = 0;
  let scroll = 0;
  let hideEmpty = false;
  let open = true;
  const bodyRows = () => process.stdout.rows - HEADER_ROWS - 1;

  const draw = () => {
    if (!open) return;
    const { columns } = process.stdout;
    const summary = summarize(state);
    const section = (title: string, lines: Line[]): Line[] => [{ text: title, kind: "title" }, ...lines, { text: "" }];
    const body =
      view === 0
        ? [
            ...section("By asset", assetLines(state, summary)),
            ...section("By auto-earn profile", profileLines(state, summary)),
            ...section("By chain", chainLines(state, summary)),
            ...noteLines(state, summary),
          ]
        : safeLines(summary, hideEmpty);
    scroll = Math.max(0, Math.min(scroll, body.length - bodyRows()));
    const below = Math.max(0, body.length - scroll - bodyRows());

    const styled = ({ text, kind }: Line) => {
      const fitted = text.length > columns ? `${text.slice(0, columns - 1)}…` : text;
      return kind ? `${STYLE[kind]}${fitted}\x1b[0m` : fitted;
    };
    const screen = [
      styled({ text: `Fluidkey balances  ${state.wallet}  ${headline(summary)}`, kind: "title" }),
      styled(statusLine(state)),
      "",
      VIEWS.map((name, i) => (i === view ? `\x1b[7m ${i + 1} ${name} \x1b[27m` : ` ${i + 1} ${name} `)).join(" "),
      "",
      ...body.slice(scroll, scroll + bodyRows()).map(styled),
      ...Array.from({ length: bodyRows() - body.length }, () => ""),
      styled({
        text:
          `Tab switch view   ↑/↓ scroll${below > 0 ? ` (${below} more below)` : ""}   ` +
          `${view === 1 ? `h ${hideEmpty ? "show" : "hide"} empty Safes   ` : ""}q quit`,
        kind: "dim",
      }),
    ];
    process.stdout.write(`\x1b[H${screen.map((line) => `${line}\x1b[K`).join("\r\n")}\x1b[J`);
  };

  const close = () => {
    if (!open) return;
    open = false;
    process.stdout.off("resize", draw);
    process.stdin.off("data", onKey);
    process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.write("\x1b[?25h\x1b[?1049l");
    resolve();
  };

  const show = (next: number) => {
    view = next;
    scroll = 0;
  };
  const keys: Record<string, () => void> = {
    q: close,
    "\x03": close,
    "\t": () => show(1 - view),
    "\x1b[C": () => show(1 - view),
    "\x1b[D": () => show(1 - view),
    "1": () => show(0),
    "2": () => show(1),
    "\x1b[A": () => scroll--,
    k: () => scroll--,
    "\x1b[B": () => scroll++,
    j: () => scroll++,
    "\x1b[5~": () => (scroll -= bodyRows()),
    "\x1b[6~": () => (scroll += bodyRows()),
    " ": () => (scroll += bodyRows()),
    g: () => (scroll = 0),
    h: () => (hideEmpty = !hideEmpty),
  };
  // A held-down key arrives as several sequences in one chunk.
  function onKey(chunk: Buffer) {
    for (const key of chunk.toString().match(/\x1b\[[0-9]*[A-Z~]|./gs) ?? []) keys[key]?.();
    draw();
  }

  // Alternate screen, so quitting gives the terminal back as it was.
  process.stdout.write("\x1b[?1049h\x1b[?25l");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", onKey);
  process.stdout.on("resize", draw);
  process.on("exit", close);
  return { refresh: draw, closed };
}
