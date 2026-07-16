import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const mainSource = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");

test("Notebook Navigator same-tab opens are redirected to focused new tabs", () => {
  assert.match(mainSource, /installNotebookNavigatorOpenPatch\(\)/);
  assert.match(mainSource, /newLeaf === false && plugin\.isNotebookNavigatorOpenRequest\(\)/);
  assert.match(mainSource, /originalGetLeaf\.call\(this, true, \.\.\.args\)/);
  assert.doesNotMatch(mainSource, /originalGetLeaf\.call\(this, true, \.\.\.args\)[\s\S]{0,400}setActiveLeaf\?\.\(leaf, \{ focus: true \}\)/);
  assert.match(mainSource, /redirectedNotebookNavigatorLeaves = new WeakSet<WorkspaceLeaf>\(\)/);
  assert.match(mainSource, /redirectedNotebookNavigatorLeaves\.add\(leaf\)/);
  assert.match(mainSource, /const patchedNotebookNavigatorOpenFile = function patchedNotebookNavigatorOpenFile/);
  assert.match(mainSource, /WorkspaceLeaf\.prototype\.openFile = patchedNotebookNavigatorOpenFile/);
  assert.match(mainSource, /active: true/);
  assert.match(mainSource, /const originalLeafSetViewState = WorkspaceLeaf\.prototype\.setViewState/);
  assert.match(mainSource, /const patchedNotebookNavigatorSetViewState = function patchedNotebookNavigatorSetViewState/);
  assert.match(mainSource, /WorkspaceLeaf\.prototype\.setViewState = patchedNotebookNavigatorSetViewState/);
  assert.match(mainSource, /workspace\.setActiveLeaf\?\.\(leaf, \{ focus: true \}\)/);
  assert.match(mainSource, /workspace\.revealLeaf\?\.\(leaf\)/);
  assert.match(mainSource, /getViewStateTargetPath/);
  assert.match(mainSource, /focusRedirectedLeafIfStillTarget/);
  assert.match(mainSource, /focusIfStillTarget/);
  assert.match(mainSource, /window\.setTimeout\(focusIfStillTarget, 100\)/);
  assert.match(mainSource, /window\.setTimeout\(focusIfStillTarget, 350\)/);
  assert.match(mainSource, /stack\.includes\("notebook-navigator"\)/);
  assert.match(mainSource, /notebookNavigatorInteractionUntil = Date\.now\(\) \+ 500/);
  assert.match(mainSource, /notebookNavigatorPendingOpenRedirect = true/);
  assert.match(mainSource, /if \(!this\.notebookNavigatorPendingOpenRedirect\) return false/);
  assert.match(mainSource, /this\.notebookNavigatorPendingOpenRedirect = false/);
  assert.match(mainSource, /target\.closest\("\.notebook-navigator"\)/);
  assert.doesNotMatch(mainSource, /Date\.now\(\) <= this\.notebookNavigatorInteractionUntil/);
});
