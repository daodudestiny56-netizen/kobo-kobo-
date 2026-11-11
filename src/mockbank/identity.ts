import type { FastifyInstance } from "fastify";
import { accounts, BVNS } from "./state.js";
import { ok, fail } from "./envelope.js";

const DOB: Record<string, string> = {
  "0123456789": "1998-04-12", "0123456790": "1985-09-30",
  "0123456791": "1992-01-17", "0123456792": "2001-06-05",
};
const NINS: Record<string, string> = Object.fromEntries(
  Object.entries(BVNS).map(([acct, bvn]) => [acct, "70000000" + bvn.slice(-3)])
);

export async function identityRoutes(v1: FastifyInstance) {
  for (const kind of ["bvn", "nin"] as const) {
    v1.post<{ Body: Record<string, string> }>(`/identity/${kind}/verify`, async (req, reply) => {
      const num = req.body?.[kind];
      if (!num) return fail(reply, "INVALID_REQUEST", `${kind} is required`, { field: kind });
      const table = kind === "bvn" ? BVNS : NINS;
      const acct = Object.keys(table).find((k) => table[k] === num);
      if (!acct) return fail(reply, "BVN_MISMATCH", "No match");
      const [first, middle, ...rest] = accounts.get(acct)!.name.split(" ");
      return ok(
        reply,
        { verified: true, first_name: first, middle_name: middle, last_name: rest.join(" "), dob: DOB[acct] },
        `${kind.toUpperCase()} verified`
      );
    });
  }
}
