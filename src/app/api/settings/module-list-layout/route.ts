/**
 * GET / PUT the list presentation for the labs, illness and checkups lists.
 *
 * GET returns every list resolved, defaults filled in, with `saved` per list
 * so a client can tell a stored choice from a default. PUT changes one list
 * with preserve-when-absent semantics: a body carrying only `view` keeps the
 * stored order and sort, and vice versa, the contract `/api/documents/inbound/layout`
 * keeps for its fields. The blob lives on its own `User` column
 * (`module_list_layout_json`).
 *
 * Both halves are the caller's own presentation, so this is an actor surface
 * (`requireActorAuth`): a browser acting for another record still reads and
 * saves the person's own layout instead of being refused. Inside somebody
 * else's record the ids in a saved order simply do not match and the list
 * keeps the server order, so no record gate is needed here.
 *
 * The PUT reads and writes the blob under a row lock in one transaction, so
 * two saves for different lists (two tabs, a quick view switch and a reorder)
 * cannot each start from the same stored value and drop the other's change.
 */
import { apiHandler, requireActorAuth } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { prisma, toJson } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import {
  MODULE_LIST_KEYS,
  resolveModuleListLayout,
  storedModuleListLayout,
} from "@/lib/settings/module-list-layout";
import { moduleListLayoutPutSchema } from "@/lib/validations/settings-prefs";

export const dynamic = "force-dynamic";

async function readStored(
  userId: string,
  db: Pick<typeof prisma, "user"> = prisma,
): Promise<unknown> {
  const row = await db.user.findUnique({
    where: { id: userId },
    select: { moduleListLayoutJson: true },
  });
  return row?.moduleListLayoutJson;
}

export const GET = apiHandler(async () => {
  const { user } = await requireActorAuth();
  const layout = resolveModuleListLayout(await readStored(user.id));
  annotate({
    action: { name: "settings.module-list-layout.read" },
    meta: {
      saved: MODULE_LIST_KEYS.filter((list) => layout.lists[list].saved),
    },
  });
  return apiSuccess(layout);
});

export const PUT = apiHandler(async (request: Request) => {
  const { user } = await requireActorAuth();

  // 500 ids of up to 64 characters plus the envelope.
  const parsed = await parseJsonBody(request, moduleListLayoutPutSchema, {
    maxBytes: 48 * 1024,
    action: "settings.module-list-layout.validation-failed",
  });
  if (!parsed.ok) return parsed.error;

  const { list, view, order, sortDir } = parsed.data;
  // Preserve-when-absent: one stored read fills whichever field the body
  // left out, and every other list stays as stored. Only fields a person has
  // chosen are written, so a field never picked keeps following the default.
  const nextStored = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM "users" WHERE "id" = ${user.id} FOR UPDATE`;
    const stored = storedModuleListLayout(await readStored(user.id, tx));
    const nextChoices = {
      ...stored[list],
      ...(view ? { view } : {}),
      ...(order ? { order: [...new Set(order)] } : {}),
      ...(sortDir ? { sortDir } : {}),
    };
    const next = { ...stored, [list]: nextChoices };
    await tx.user.update({
      where: { id: user.id },
      data: { moduleListLayoutJson: toJson({ version: 1, ...next }) },
    });
    return next;
  });

  const layout = resolveModuleListLayout(nextStored);
  annotate({
    action: { name: "settings.module-list-layout.update" },
    meta: {
      list,
      view: layout.lists[list].view,
      sortDir: layout.lists[list].sortDir,
      orderLength: layout.lists[list].order.length,
    },
  });
  return apiSuccess(layout);
});
