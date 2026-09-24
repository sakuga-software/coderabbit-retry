export const ENABLE_MOUSE = "\u001B[?1000h\u001B[?1006h";
export const DISABLE_MOUSE = "\u001B[?1006l\u001B[?1000l";

export type MouseEvent =
  | { kind: "click"; x: number; y: number }
  | { kind: "wheel"; direction: "up" | "down"; x: number; y: number };

const SEQUENCE = /\u001B\[<(\d+);(\d+);(\d+)([Mm])/g;
const INCOMPLETE_TAIL = /\u001B(\[(<[\d;]*)?)?$/;

/**
 * Decodes SGR mouse reports (mode 1006) from raw terminal input.
 * The terminal can split one report across two chunks, so the parser keeps an incomplete tail.
 * Coordinates are 0-based: x is the column, y is the line.
 * The returned function tells if the chunk completed a report that an earlier chunk started.
 * Ink then passes the end of that report, for example "m", to useInput as if it were a key.
 */
export function createMouseParser(onEvent: (event: MouseEvent) => void) {
  let pending = "";
  return (chunk: string): boolean => {
    const carried = pending.length;
    const data = pending + chunk;
    let end = 0;
    let completedCarried = false;
    for (const match of data.matchAll(SEQUENCE)) {
      end = match.index + match[0].length;
      if (carried > 0 && match.index < carried) completedCarried = true;
      const [, code, column, line, final] = match;
      const button = Number(code);
      const x = Number(column) - 1;
      const y = Number(line) - 1;
      if (button === 64 || button === 65) onEvent({ kind: "wheel", direction: button === 64 ? "up" : "down", x, y });
      else if (button === 0 && final === "M") onEvent({ kind: "click", x, y });
    }
    const rest = data.slice(end);
    pending = INCOMPLETE_TAIL.exec(rest)?.[0] ?? "";
    return completedCarried;
  };
}

/** Tells if a string from Ink's useInput is a piece of a mouse report and not a key press. */
export const isMouseFragment = (input: string) => /^\[?<[\d;]*[Mm]?$|^[\d;]+[Mm]$/.test(input) && input !== "";
