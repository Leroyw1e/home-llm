export interface DiffLine {
	type: "same" | "del" | "add" | "gap";
	text: string;
}

/** Lines of unchanged context shown around each change. */
const CONTEXT = 2;
/** Above this many changed lines on a side, skip the line-matching step and show old then new. */
const MATCH_LIMIT = 400;

/** Line diff between two texts, with a little unchanged context around the changes. */
export function lineDiff(before: string, after: string): DiffLine[] {
	// An empty note has no lines (not one empty line), so a new note shows only additions.
	const a = before === "" ? [] : before.split("\n");
	const b = after === "" ? [] : after.split("\n");
	let start = 0;
	while (start < a.length && start < b.length && a[start] === b[start]) start++;
	let endA = a.length;
	let endB = b.length;
	while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
		endA--;
		endB--;
	}
	const midA = a.slice(start, endA);
	const midB = b.slice(start, endB);

	let middle: DiffLine[];
	if (midA.length > MATCH_LIMIT || midB.length > MATCH_LIMIT) {
		middle = [...midA.map((t) => ({ type: "del" as const, text: t })), ...midB.map((t) => ({ type: "add" as const, text: t }))];
	} else {
		// Longest common subsequence over the changed middle, so moved-around lines read naturally.
		const n = midA.length;
		const m = midB.length;
		const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
		for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = midA[i] === midB[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
		middle = [];
		let i = 0;
		let j = 0;
		while (i < n || j < m) {
			if (i < n && j < m && midA[i] === midB[j]) {
				middle.push({ type: "same", text: midA[i++] });
				j++;
			} else if (i < n && (j >= m || lcs[i + 1][j] >= lcs[i][j + 1])) middle.push({ type: "del", text: midA[i++] });
			else middle.push({ type: "add", text: midB[j++] });
		}
	}

	const out: DiffLine[] = [];
	if (start > CONTEXT) out.push({ type: "gap", text: `${start - CONTEXT} unchanged lines` });
	for (let i = Math.max(0, start - CONTEXT); i < start; i++) out.push({ type: "same", text: a[i] });
	out.push(...middle);
	const tail = a.length - endA;
	for (let i = endA; i < Math.min(a.length, endA + CONTEXT); i++) out.push({ type: "same", text: a[i] });
	if (tail > CONTEXT) out.push({ type: "gap", text: `${tail - CONTEXT} unchanged lines` });
	return out;
}
