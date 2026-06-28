// Manual live smoke test — exercises the engine against a REAL TriliumNext
// instance. Two halves:
//   1-4) the ETAPI calls unit tests can only mock: createLabel, searchNotes,
//        patchNote (title), patchAttribute (connection label).
//   5-7) the core data path, live: hash-diff incremental skip, special-char
//        paths, and delete reconcile (soft tombstone, hard delete, orphan dirs).
//        These restore coverage that previously lived in a throwaway scratchpad
//        harness, so the live gate now matches the offline unit gate.
//   8-12) grouping + read-only: container nesting + stamping, container reuse,
//        move-on-group-change (branch re-parent, noteId preserved), parentNoteId
//        nesting, and the read-only mirror — including THE GATE that our own ETAPI
//        PUT /content still updates a #readOnly note (else sync would break).
//
// This is NOT part of `pnpm test` (which is pure-logic, offline). It's excluded
// from the .vsix via .vscodeignore (test/**). Run it by hand before a release or
// after touching the ETAPI client / stamping / recovery code.
//
//   ETAPI_TOKEN=<token> [TRILIUM_URL=http://localhost:8080] \
//     node --import tsx test/manual/smoke.mjs
//
// It creates a throwaway backup tree under a unique connection/workspace name and
// deletes it at the end, so it leaves no residue in your Trilium even on success.
// The token is read from the environment and never printed.

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";

import { EtapiClient } from "../../src/etapiClient.ts";
import { SyncEngine, renameRootConnectionLabel } from "../../src/sync.ts";

// These mirror the (unexported) label names in src/sync.ts. Kept in sync by hand;
// if they drift, the recovery-search assertion below fails loudly.
const ROOT_LABEL = "trilkeepRoot";
const CONNECTION_LABEL = "trilkeepConnection";
const WORKSPACE_LABEL = "trilkeepWorkspace";
const CONTAINER_PATH_LABEL = "trilkeepContainerPath";
const READONLY_LABEL = "readOnly";

const TOKEN = process.env.ETAPI_TOKEN;
const SERVER_URL = process.env.TRILIUM_URL || "http://localhost:8080";

if (!TOKEN) {
  console.error(
    "ETAPI_TOKEN env var is required. Generate one in Trilium → Options → ETAPI.\n" +
      "  ETAPI_TOKEN=<token> node --import tsx test/manual/smoke.mjs"
  );
  process.exit(2);
}

let passed = 0;
let failed = 0;
function check(label, cond, detail = "") {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const silentLog = () => {};
const reporter = { report: () => {}, isCancelled: () => false };

/** A backup root carries these three labels once stamped. */
function rootLabels(note) {
  const labels = {};
  for (const a of note?.attributes ?? []) {
    if (a.type === "label") labels[a.name] = a.value ?? "";
  }
  return labels;
}

async function main() {
  const client = new EtapiClient(SERVER_URL, TOKEN);

  // Fail fast with a clear message if the server/token is wrong.
  const info = await client.appInfo();
  console.log(`Connected to Trilium ${info.appVersion} (db ${info.dbVersion}) at ${SERVER_URL}\n`);

  // Unique identity per run so a crashed prior run can't make recovery ambiguous.
  const suffix = crypto.randomBytes(4).toString("hex");
  const connectionName = `smoke-${suffix}`;
  const workspaceName = `smoke-ws-${suffix}`;
  const rootTitleV1 = "Trilkeep Smoke";
  const rootTitleV2 = "Trilkeep Smoke (renamed)";

  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "trilkeep-smoke-"));
  let rootNoteId; // captured for cleanup
  let workspaceRoot2; // second throwaway tree for the core data-path scenarios
  let rootNoteId2; // captured for cleanup
  // Grouping/read-only scenarios: their throwaway trees + any container/root/parent
  // notes to delete at the end (deleting a top container cascades to its subtree).
  let workspaceRoot3, workspaceRoot3b, workspaceRoot3c, workspaceRoot3d;
  const cleanupIds = [];

  // The Trilium note a given note currently sits under (via its first branch).
  const parentOf = async (noteId) => {
    const n = await client.getNote(noteId);
    const branchId = n?.parentBranchIds?.[0];
    if (!branchId) return undefined;
    const b = await client.getBranch(branchId);
    return b?.parentNoteId;
  };

  try {
    await fs.writeFile(path.join(workspaceRoot, "a.md"), "# A\n");
    await fs.mkdir(path.join(workspaceRoot, "sub"));
    await fs.writeFile(path.join(workspaceRoot, "sub", "b.md"), "# B\n");
    const files = ["a.md", "sub/b.md"];

    const baseOpts = {
      workspaceRoot,
      workspaceName,
      connectionName,
      hardDeleteRemovedFiles: false,
    };

    // 1) createLabel — first backup creates the root and stamps three labels.
    console.log("1) createLabel — stamp the backup root");
    const manifest = { version: 1, entries: {} };
    const engine1 = new SyncEngine(
      client,
      manifest,
      { ...baseOpts, rootNoteTitle: rootTitleV1 },
      silentLog
    );
    const summary = await engine1.backup(files, reporter);
    rootNoteId = manifest.rootNoteId;
    check("backup created the file notes", summary.created === 2, `created=${summary.created}`);
    check("root noteId recorded", !!rootNoteId);
    const stampedNote = await client.getNote(rootNoteId);
    const labels = rootLabels(stampedNote);
    check("root has #trilkeepRoot", ROOT_LABEL in labels);
    check(
      "root has #trilkeepConnection = connectionName",
      labels[CONNECTION_LABEL] === connectionName,
      `got "${labels[CONNECTION_LABEL]}"`
    );
    check(
      "root has #trilkeepWorkspace = workspaceName",
      labels[WORKSPACE_LABEL] === workspaceName,
      `got "${labels[WORKSPACE_LABEL]}"`
    );
    check(
      "root title is v1",
      stampedNote?.title === rootTitleV1,
      `got "${stampedNote?.title}"`
    );

    // 2) searchNotes — the stamp must be findable by the recovery query, so a
    //    lost manifest re-attaches instead of duplicating the root.
    console.log("\n2) searchNotes — recover the root by its stamp");
    const query =
      `#${ROOT_LABEL} ` +
      `#${CONNECTION_LABEL}="${connectionName}" ` +
      `#${WORKSPACE_LABEL}="${workspaceName}"`;
    const found = await client.searchNotes(query, { ancestorNoteId: "root", limit: 2 });
    check("search returns exactly one match", found.length === 1, `got ${found.length}`);
    check("search match is our root", found[0]?.noteId === rootNoteId);

    // Drive it through the engine too: a fresh manifest (no rootNoteId) must
    // re-attach to the same root via findExistingRoot, not create a new one.
    const manifest2 = { version: 1, entries: {} };
    const engine2 = new SyncEngine(
      client,
      manifest2,
      { ...baseOpts, rootNoteTitle: rootTitleV1 },
      silentLog
    );
    await engine2.backup(files, reporter);
    check(
      "engine re-attached to the same root (no duplicate)",
      manifest2.rootNoteId === rootNoteId,
      `new=${manifest2.rootNoteId}`
    );

    // 3) patchNote — changing rootNoteTitle renames the existing root note.
    console.log("\n3) patchNote — title sync renames the root");
    const engine3 = new SyncEngine(
      client,
      manifest,
      { ...baseOpts, rootNoteTitle: rootTitleV2 },
      silentLog
    );
    await engine3.backup(files, reporter);
    const renamed = await client.getNote(rootNoteId);
    check(
      "root title updated to v2",
      renamed?.title === rootTitleV2,
      `got "${renamed?.title}"`
    );

    // 4) patchAttribute — renameRootConnectionLabel rewrites the connection label.
    console.log("\n4) patchAttribute — rewrite the connection label");
    const newConnectionName = `${connectionName}-moved`;
    await renameRootConnectionLabel(client, rootNoteId, newConnectionName);
    const relabeled = await client.getNote(rootNoteId);
    check(
      "connection label now holds the new name",
      rootLabels(relabeled)[CONNECTION_LABEL] === newConnectionName,
      `got "${rootLabels(relabeled)[CONNECTION_LABEL]}"`
    );

    // ── Core data-path scenarios, against a second throwaway tree under its own
    //    connection/workspace so it can't collide with the recovery test above. ──
    workspaceRoot2 = await fs.mkdtemp(path.join(os.tmpdir(), "trilkeep-smoke2-"));
    const baseOpts2 = {
      workspaceRoot: workspaceRoot2,
      workspaceName: `smoke2-ws-${suffix}`,
      connectionName: `smoke2-${suffix}`,
      rootNoteTitle: "Trilkeep Smoke 2",
      hardDeleteRemovedFiles: false,
    };
    await fs.writeFile(path.join(workspaceRoot2, "a.md"), "# A\n");
    await fs.mkdir(path.join(workspaceRoot2, "sub"));
    await fs.writeFile(path.join(workspaceRoot2, "sub", "b.md"), "# B\n");
    // A path with a space and an ampersand: exercises createNote/putContent for
    // an awkward title and the noteId-in-URL handling end-to-end (finding #7).
    const specialRel = "nested/a b & c.md";
    await fs.mkdir(path.join(workspaceRoot2, "nested"));
    await fs.writeFile(path.join(workspaceRoot2, specialRel), "# special\n");
    const files2 = ["a.md", "sub/b.md", specialRel];
    const manifest3 = { version: 1, entries: {} };
    const run = (opts, files) =>
      new SyncEngine(client, manifest3, opts, silentLog).backup(files, reporter);

    // 5) hash-diff incremental — the core value prop: unchanged files are skipped,
    //    only a changed file re-uploads.
    console.log("\n5) hash-diff incremental — skip unchanged, re-upload changed");
    const sum5a = await run(baseOpts2, files2);
    rootNoteId2 = manifest3.rootNoteId;
    check("first backup creates every file", sum5a.created === 3, `created=${sum5a.created}`);
    const sum5b = await run(baseOpts2, files2);
    check(
      "re-running with no changes skips everything",
      sum5b.created === 0 && sum5b.updated === 0 && sum5b.skipped === 3,
      `created=${sum5b.created} updated=${sum5b.updated} skipped=${sum5b.skipped}`
    );
    await fs.writeFile(path.join(workspaceRoot2, "a.md"), "# A changed\n");
    const sum5c = await run(baseOpts2, files2);
    check(
      "a changed file re-uploads, the rest still skip",
      sum5c.updated === 1 && sum5c.skipped === 2 && sum5c.created === 0,
      `updated=${sum5c.updated} skipped=${sum5c.skipped} created=${sum5c.created}`
    );

    // 6) special-char path — the awkward title round-trips to a real child note.
    console.log("\n6) special-char path — awkward title creates a real note");
    const specialEntry = manifest3.entries[specialRel];
    check("special-char file is tracked in the manifest", !!specialEntry?.noteId);
    const specialNote = specialEntry ? await client.getNote(specialEntry.noteId) : null;
    check(
      "special-char note exists with the basename title",
      specialNote?.title === "a b & c.md",
      `got "${specialNote?.title}"`
    );

    // 7) delete reconcile — soft keeps + tombstones; hard deletes + prunes orphan dirs.
    console.log("\n7) delete reconcile — soft keep/tombstone, then hard delete + orphan dir");
    const aNoteId = manifest3.entries["a.md"].noteId;
    const bNoteId = manifest3.entries["sub/b.md"].noteId;
    const subDirNoteId = manifest3.entries["sub"]?.noteId;
    // Soft: drop a.md from the file list; a full (reconciling) backup tombstones it
    // but keeps the note in Trilium.
    await fs.rm(path.join(workspaceRoot2, "a.md"));
    const filesNoA = ["sub/b.md", specialRel];
    const sum7soft = await run(baseOpts2, filesNoA);
    check("soft delete reports one removal", sum7soft.removed === 1, `removed=${sum7soft.removed}`);
    check("soft delete tombstones the manifest entry", manifest3.entries["a.md"]?.removed === true);
    check("soft delete KEEPS the note in Trilium", (await client.getNote(aNoteId)) !== null);
    const sum7again = await run(baseOpts2, filesNoA);
    check(
      "soft-delete removal is logged once, not repeated",
      sum7again.removed === 0,
      `removed=${sum7again.removed}`
    );
    // Hard: remove the remaining sub/b.md and reconcile with hardDelete → the note
    // is deleted and the now-empty "sub" directory note is pruned.
    await fs.rm(path.join(workspaceRoot2, "sub", "b.md"));
    await run({ ...baseOpts2, hardDeleteRemovedFiles: true }, [specialRel]);
    check("hard delete removes the note from Trilium", (await client.getNote(bNoteId)) === null);
    check(
      "hard delete prunes the orphaned directory note",
      !!subDirNoteId && (await client.getNote(subDirNoteId)) === null,
      subDirNoteId ? "still present" : "no sub dir entry in manifest"
    );

    // ── Grouping (container nesting / move / parentNoteId) + read-only mirror. ──
    workspaceRoot3 = await fs.mkdtemp(path.join(os.tmpdir(), "trilkeep-smoke3-"));
    await fs.writeFile(path.join(workspaceRoot3, "note.md"), "# N\n");
    const baseOpts3 = {
      workspaceRoot: workspaceRoot3,
      workspaceName: `smoke3-ws-${suffix}`,
      connectionName: `smoke3-${suffix}`,
      rootNoteTitle: "",
      hardDeleteRemovedFiles: false,
    };
    const manifest4 = { version: 1, entries: {} };
    const groupLogs = [];
    const glog = (m) => groupLogs.push(m);
    const run3 = (opts) =>
      new SyncEngine(client, manifest4, opts, glog).backup(["note.md"], reporter);

    // 8) group nesting — a "SmokeG/sub" path creates two stamped containers and
    //    nests the workspace root under the deepest one.
    console.log("\n8) group nesting — containers created + stamped, root nested");
    await run3({ ...baseOpts3, group: `SmokeG-${suffix}/sub` });
    const groupRootId = manifest4.rootNoteId;
    const subContainerId = manifest4.rootParentNoteId;
    const subNote = await client.getNote(subContainerId);
    check(
      "deepest container stamped with its full path",
      rootLabels(subNote)[CONTAINER_PATH_LABEL] === `SmokeG-${suffix}/sub`,
      `got "${rootLabels(subNote)[CONTAINER_PATH_LABEL]}"`
    );
    check(
      "workspace root is nested under the deepest container",
      (await parentOf(groupRootId)) === subContainerId
    );
    const topContainerId = await parentOf(subContainerId);
    const topNote = await client.getNote(topContainerId);
    check(
      "parent container stamped with its path",
      rootLabels(topNote)[CONTAINER_PATH_LABEL] === `SmokeG-${suffix}`
    );
    check(
      "top container sits directly under Trilium root",
      (await parentOf(topContainerId)) === "root"
    );
    cleanupIds.push(topContainerId); // cascades to sub + roots beneath it

    // 9) container reuse — a second workspace under the same group shares the
    //    SAME deepest container (found by its stamp, not duplicated).
    console.log("\n9) container reuse — second workspace shares the container");
    workspaceRoot3b = await fs.mkdtemp(path.join(os.tmpdir(), "trilkeep-smoke3b-"));
    await fs.writeFile(path.join(workspaceRoot3b, "note.md"), "# N2\n");
    const manifest5 = { version: 1, entries: {} };
    await new SyncEngine(
      client,
      manifest5,
      {
        ...baseOpts3,
        workspaceRoot: workspaceRoot3b,
        workspaceName: `smoke3b-ws-${suffix}`,
        connectionName: `smoke3b-${suffix}`,
        group: `SmokeG-${suffix}/sub`,
      },
      silentLog
    ).backup(["note.md"], reporter);
    check(
      "second workspace reuses the same container (no duplicate)",
      manifest5.rootParentNoteId === subContainerId,
      `got ${manifest5.rootParentNoteId}`
    );

    // 10) move on group change — re-parent the root, preserving its noteId.
    console.log("\n10) move on group change — root re-parented, noteId preserved");
    await run3({ ...baseOpts3, group: `SmokeG2-${suffix}` });
    // Surface any best-effort grouping/move failure the engine swallowed (silent
    // on success), so a regression here isn't invisible.
    const groupProblems = groupLogs.filter((l) => /could not|failed/i.test(l));
    if (groupProblems.length) {
      console.log(`   [diag] ${groupProblems.join(" | ")}`);
    }
    check(
      "root noteId is unchanged after the group change",
      manifest4.rootNoteId === groupRootId,
      `got ${manifest4.rootNoteId}`
    );
    const movedParent = await parentOf(groupRootId);
    check(
      "root now lives under the new group container",
      movedParent === manifest4.rootParentNoteId && movedParent !== subContainerId,
      `parent=${movedParent}`
    );
    check(
      "new container stamped with its path, under Trilium root",
      rootLabels(await client.getNote(movedParent))[CONTAINER_PATH_LABEL] ===
        `SmokeG2-${suffix}` && (await parentOf(movedParent)) === "root"
    );
    cleanupIds.push(movedParent); // SmokeG2 container now holds the moved root

    // 11) parentNoteId — nest the root directly under an existing (user) note,
    //     with no Trilkeep containers in between.
    console.log("\n11) parentNoteId — nest under an existing note, no containers");
    workspaceRoot3c = await fs.mkdtemp(path.join(os.tmpdir(), "trilkeep-smoke3c-"));
    await fs.writeFile(path.join(workspaceRoot3c, "note.md"), "# N3\n");
    const userNote = await client.createNote({
      parentNoteId: "root",
      title: `Smoke User Note ${suffix}`,
      type: "book",
      content: "",
    });
    cleanupIds.push(userNote.note.noteId);
    const manifest6 = { version: 1, entries: {} };
    await new SyncEngine(
      client,
      manifest6,
      {
        ...baseOpts3,
        workspaceRoot: workspaceRoot3c,
        workspaceName: `smoke3c-ws-${suffix}`,
        connectionName: `smoke3c-${suffix}`,
        group: "",
        parentNoteId: userNote.note.noteId,
      },
      silentLog
    ).backup(["note.md"], reporter);
    check(
      "root nested directly under the given parentNoteId",
      (await parentOf(manifest6.rootNoteId)) === userNote.note.noteId &&
        manifest6.rootParentNoteId === userNote.note.noteId
    );

    // 12) read-only mirror — inheritable #readOnly label + THE GATE: our own ETAPI
    //     PUT /content must still update a #readOnly note (else sync silently breaks).
    console.log("\n12) read-only mirror — inheritable label + writes still work (gate)");
    workspaceRoot3d = await fs.mkdtemp(path.join(os.tmpdir(), "trilkeep-smoke3d-"));
    await fs.writeFile(path.join(workspaceRoot3d, "note.md"), "# RO\n");
    const manifest7 = { version: 1, entries: {} };
    const roOpts = {
      ...baseOpts3,
      workspaceRoot: workspaceRoot3d,
      workspaceName: `smoke3d-ws-${suffix}`,
      connectionName: `smoke3d-${suffix}`,
      group: "",
      readOnly: true,
    };
    await new SyncEngine(client, manifest7, roOpts, silentLog).backup(["note.md"], reporter);
    cleanupIds.push(manifest7.rootNoteId);
    const roRoot = await client.getNote(manifest7.rootNoteId);
    const roAttr = (roRoot?.attributes ?? []).find(
      (a) => a.type === "label" && a.name === READONLY_LABEL
    );
    check("root carries a #readOnly label", !!roAttr);
    check(
      "#readOnly is inheritable (cascades to the subtree)",
      roAttr?.isInheritable === true,
      `isInheritable=${roAttr?.isInheritable}`
    );
    // THE GATE: write to the child note despite the inheritable #readOnly, then
    // read it back. If this fails, read-only blocks our sync and can't ship as-is.
    const roChildId = manifest7.entries["note.md"].noteId;
    let writeErr = "";
    try {
      await client.putContent(roChildId, "# RO changed by smoke\n");
    } catch (e) {
      writeErr = e.message;
    }
    const roBack = writeErr ? "" : await client.getContent(roChildId);
    check(
      "ETAPI PUT /content still updates a #readOnly note (sync NOT broken)",
      roBack.trim() === "# RO changed by smoke",
      writeErr ? `write rejected: ${writeErr}` : `read back "${roBack.trim()}"`
    );
    // Toggle the setting off → the inheritable label is removed.
    await new SyncEngine(
      client,
      manifest7,
      { ...roOpts, readOnly: false },
      silentLog
    ).backup(["note.md"], reporter);
    const roRoot2 = await client.getNote(manifest7.rootNoteId);
    check(
      "#readOnly removed when the setting is turned off",
      !(roRoot2?.attributes ?? []).some(
        (a) => a.type === "label" && a.name === READONLY_LABEL
      )
    );
  } finally {
    // Tear down the throwaway tree (cascades to children) and the temp folder, so
    // a successful run leaves no residue in Trilium.
    for (const id of [rootNoteId, rootNoteId2, ...cleanupIds]) {
      if (id) {
        await client.deleteNote(id).catch((e) =>
          console.log(`  (cleanup) could not delete note ${id}: ${e.message}`)
        );
      }
    }
    for (const dir of [
      workspaceRoot,
      workspaceRoot2,
      workspaceRoot3,
      workspaceRoot3b,
      workspaceRoot3c,
      workspaceRoot3d,
    ]) {
      if (dir) {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(`\nSmoke run errored: ${e.message}`);
  process.exit(1);
});
