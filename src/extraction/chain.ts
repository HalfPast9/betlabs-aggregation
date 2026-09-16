export interface ChainRow {
  timestamp: string | null;
  type: string | null;
  amount: number | null;
  balanceBefore: number | null;
  balanceAfter: number | null;
}

export interface ChainBreak {
  /** Index (in the input's display order) of the first row of the group where the chain fails. */
  rowIndex: number;
  kind: "link" | "group" | "unreadable";
  detail: string;
}

export interface ChainResult {
  /** Every row participates and every link holds — the extraction is complete. */
  complete: boolean;
  breaks: ChainBreak[];
  /** True if the list displays newest first (row 0 is the latest transaction). */
  newestFirst: boolean;
  startBalance: number | null;
  endBalance: number | null;
  /** How many rows could be checked (had a usable before/after pair). */
  checkedRows: number;
}

const CENTS = 100;
const key = (v: number) => Math.round(v * CENTS);

/**
 * The UI hands us ground truth: every transaction's balance-before must
 * equal the previous transaction's balance-after. That makes completeness
 * *verifiable* — a missing or misread row breaks the chain — which is the
 * difference between "we read some rows" and "we read all of them".
 *
 * Two wrinkles this handles:
 * - Direction is unknown (newest-first vs oldest-first); both are tried.
 * - Within a group of rows sharing a displayed timestamp (minute precision
 *   is common), the UI's own order isn't reliably chronological. So a group
 *   is checked as a multiset: the rows must form *some* valid path from the
 *   group's incoming balance to its outgoing one, without insisting on the
 *   display order.
 */
export function verifyChain(rowsInDisplayOrder: ChainRow[]): ChainResult {
  // A UI that shows no balances at all (only signed changes) can't be
  // chain-verified. That's "not checkable", not a break per row.
  if (!rowsInDisplayOrder.some((r) => r.balanceAfter !== null || r.balanceBefore !== null)) {
    return { complete: false, breaks: [], newestFirst: true, startBalance: null, endBalance: null, checkedRows: 0 };
  }
  const forward = check(rowsInDisplayOrder.map((r, i) => ({ r, i })));
  const backward = check([...rowsInDisplayOrder.map((r, i) => ({ r, i }))].reverse());
  // Prefer the direction with fewer breaks; tie → assume newest-first, the more common layout.
  const newestFirst = backward.breaks.length <= forward.breaks.length;
  const chosen = newestFirst ? backward : forward;
  return { ...chosen, newestFirst };
}

/**
 * Same instant, however it was written: parseable dates compare as dates;
 * anything else compares as an order-insensitive bag of tokens, so
 * "11/30/25 1:38 PM" and "1:38 PM 11/30/25" group together.
 */
function timestampKey(ts: string | null): string {
  if (ts === null) return "";
  const d = new Date(ts);
  if (!Number.isNaN(d.getTime())) return d.toISOString();
  return ts.toLowerCase().split(/[\s,]+/).filter(Boolean).sort().join(" ");
}

interface Edge {
  before: number;
  after: number;
  i: number;
}

function signedAmount(r: ChainRow): number | null {
  if (r.amount === null) return null;
  if (r.amount < 0) return r.amount;
  if (r.type === "bet" || r.type === "withdrawal") return -r.amount;
  return r.amount;
}

function toEdge(r: ChainRow, i: number): Edge | null {
  if (r.balanceBefore !== null && r.balanceAfter !== null) return { before: r.balanceBefore, after: r.balanceAfter, i };
  const delta = signedAmount(r);
  if (r.balanceAfter !== null && delta !== null) return { before: r.balanceAfter - delta, after: r.balanceAfter, i };
  if (r.balanceBefore !== null && delta !== null) return { before: r.balanceBefore, after: r.balanceBefore + delta, i };
  return null;
}

function check(seq: Array<{ r: ChainRow; i: number }>): Omit<ChainResult, "newestFirst"> {
  const breaks: ChainBreak[] = [];
  let prevOut: number | null = null;
  let startBalance: number | null = null;
  let checkedRows = 0;

  // Group consecutive rows by displayed timestamp; untimestamped rows stand alone.
  const groups: Array<Array<{ r: ChainRow; i: number }>> = [];
  for (const item of seq) {
    const last = groups[groups.length - 1];
    if (last && item.r.timestamp !== null && timestampKey(last[0]!.r.timestamp) === timestampKey(item.r.timestamp)) last.push(item);
    else groups.push([item]);
  }

  for (const group of groups) {
    const first = group[0]!.i;

    // A session card split into a bet row (no balances) and a win row (the
    // card's balance) can't be checked edge by edge; the group as a whole
    // must move from the incoming balance by the sum of its amounts.
    const amountOnly = group.filter(({ r }) => toEdge(r, 0) === null && signedAmount(r) !== null);
    if (amountOnly.length > 0) {
      const withBalance = group.filter(({ r }) => r.balanceAfter !== null);
      const net = group.reduce((acc, { r }) => acc + (signedAmount(r) ?? 0), 0);
      for (const { r, i } of group) {
        if (signedAmount(r) === null && r.balanceAfter === null && r.balanceBefore === null) {
          breaks.push({ rowIndex: i, kind: "unreadable", detail: "no usable balance/amount to check" });
        }
      }
      if (withBalance.length === 0) {
        breaks.push({ rowIndex: first, kind: "unreadable", detail: "rows carry amounts but no balance to check them against" });
        continue;
      }
      checkedRows += group.length;
      const afters = withBalance.map(({ r }) => r.balanceAfter!);
      let out: number;
      if (prevOut !== null) {
        const match = afters.find((v) => key(v - net) === key(prevOut!));
        if (match === undefined) {
          breaks.push({
            rowIndex: first,
            kind: "link",
            detail: `previous balance was ${prevOut.toFixed(2)}; these rows net ${net >= 0 ? "+" : ""}${net.toFixed(2)} but end at ${afters.map((v) => v.toFixed(2)).join("/")}`,
          });
          out = afters[afters.length - 1]!;
        } else {
          out = match;
        }
      } else {
        out = afters[afters.length - 1]!;
        startBalance = out - net;
      }
      prevOut = out;
      continue;
    }

    const edges: Edge[] = [];
    for (const { r, i } of group) {
      const e = toEdge(r, i);
      if (e) edges.push(e);
      else breaks.push({ rowIndex: i, kind: "unreadable", detail: "no usable balance/amount to check" });
    }
    if (edges.length === 0) continue;
    checkedRows += edges.length;

    const befores = new Map<number, number>();
    const afters = new Map<number, number>();
    for (const e of edges) {
      befores.set(key(e.before), (befores.get(key(e.before)) ?? 0) + 1);
      afters.set(key(e.after), (afters.get(key(e.after)) ?? 0) + 1);
    }
    const ins: number[] = [];
    const outs: number[] = [];
    for (const [k, n] of befores) {
      const extra = n - (afters.get(k) ?? 0);
      for (let j = 0; j < extra; j++) ins.push(k / CENTS);
    }
    for (const [k, n] of afters) {
      const extra = n - (befores.get(k) ?? 0);
      for (let j = 0; j < extra; j++) outs.push(k / CENTS);
    }

    if (ins.length > 1 || outs.length > 1) {
      breaks.push({
        rowIndex: first,
        kind: "group",
        detail: `rows timestamped ${group[0]!.r.timestamp ?? "(none)"} don't form a single chain (loose starts: ${ins.join(", ")}; loose ends: ${outs.join(", ")})`,
      });
      prevOut = outs.length > 0 ? outs[outs.length - 1]! : prevOut;
      continue;
    }

    let groupIn: number;
    let groupOut: number;
    if (ins.length === 1) {
      groupIn = ins[0]!;
      groupOut = outs[0]!;
    } else {
      // A closed loop (e.g. 100→99→100): enters and leaves at the same value.
      groupIn = prevOut ?? edges[0]!.before;
      groupOut = groupIn;
      if (!befores.has(key(groupIn))) {
        breaks.push({ rowIndex: first, kind: "link", detail: `expected a row starting from ${groupIn.toFixed(2)}, none does` });
        prevOut = edges[edges.length - 1]!.after;
        continue;
      }
    }

    if (startBalance === null) startBalance = groupIn;
    if (prevOut !== null && key(prevOut) !== key(groupIn)) {
      breaks.push({
        rowIndex: first,
        kind: "link",
        detail: `previous balance was ${prevOut.toFixed(2)} but the next row starts from ${groupIn.toFixed(2)}`,
      });
    }
    prevOut = groupOut;
  }

  return { complete: breaks.length === 0 && checkedRows > 0, breaks, startBalance, endBalance: prevOut, checkedRows };
}
