import type { PlainMessage } from "./types.ts";

/** Query text for memory retrieval: the head's user-like text. */
export function queryFromHead(head: PlainMessage[]): string {
	return head
		.filter((m) => m.role === "user")
		.map((m) => m.text)
		.join("\n")
		.slice(0, 8000);
}
