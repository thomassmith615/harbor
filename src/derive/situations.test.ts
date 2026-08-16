/**
 * What situation identity must do.
 *
 * These are written against the matcher rather than against the pipeline on
 * purpose. The failure this milestone exists to fix was invisible end to end:
 * every situation looked correct on any single run, and the defect only showed
 * up as a dismissal quietly returning days later. That is not something reading
 * output catches, which is the same lesson the fixture suite was built on.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { pairProposals } from "./situations.js";
import type { NodeRef } from "../store/nodes.js";

function refs(...ids: string[]): readonly NodeRef[] {
  return ids.map((id) => ({ kind: "item", id }) as NodeRef);
}

function existing(id: string, ...ids: string[]): {
  readonly id: string;
  readonly nodeKeys: ReadonlySet<string>;
} {
  return { id, nodeKeys: new Set(ids.map((node) => `item:${node}`)) };
}

test("situation identity", async (t) => {
  await t.test("a situation that grows keeps its id", () => {
    const paired = pairProposals(
      [{ nodes: refs("a", "b", "c", "d") }],
      [existing("sit_one", "a", "b", "c")],
    );

    assert.equal(paired.length, 1);
    assert.equal(paired[0]?.situationId, "sit_one");
  });

  await t.test("a situation that loses a node keeps its id", () => {
    const paired = pairProposals([{ nodes: refs("a", "b") }], [existing("sit_one", "a", "b", "c")]);

    assert.equal(paired[0]?.situationId, "sit_one");
  });

  await t.test("two nodes in common out of many is not the same situation", () => {
    // The overlap is 2, which clears MIN_SHARED, but it is a fifth of the
    // smaller side. Something brushing past a big situation is not that
    // situation, and treating it as one silently welds unrelated things
    // together under a name the person already trusts.
    const paired = pairProposals(
      [{ nodes: refs("a", "b", "x", "y", "z", "w", "v", "u", "t", "s") }],
      [existing("sit_one", "a", "b", "c", "d", "e", "f", "g", "h", "i", "j")],
    );

    assert.equal(paired.length, 0);
  });

  await t.test("one shared node is never a match", () => {
    const paired = pairProposals([{ nodes: refs("a", "z") }], [existing("sit_one", "a", "b")]);

    assert.equal(paired.length, 0);
  });

  await t.test("a merge gives the id to the larger overlap, once", () => {
    // Two situations joined by a new edge. One proposal, two candidates, and
    // exactly one of them may survive: handing the same id to two rows, or two
    // ids to one row, is the corruption this function exists to prevent.
    const paired = pairProposals(
      [{ nodes: refs("a", "b", "c", "d", "e") }],
      [existing("sit_big", "a", "b", "c"), existing("sit_small", "d", "e")],
    );

    assert.equal(paired.length, 1);
    assert.equal(paired[0]?.situationId, "sit_big");
  });

  await t.test("a split gives the id to the larger overlap and the rest is new", () => {
    const paired = pairProposals(
      [{ nodes: refs("a", "b", "c") }, { nodes: refs("d", "e") }],
      [existing("sit_one", "a", "b", "c", "d", "e")],
    );

    assert.equal(paired.length, 1);
    assert.equal(paired[0]?.proposalIndex, 0);
    assert.equal(paired[0]?.situationId, "sit_one");
  });

  await t.test("no proposal takes two situations and no situation takes two proposals", () => {
    const paired = pairProposals(
      [
        { nodes: refs("a", "b", "c") },
        { nodes: refs("a", "b", "c") },
        { nodes: refs("d", "e", "f") },
      ],
      [existing("sit_one", "a", "b", "c"), existing("sit_two", "d", "e", "f")],
    );

    const proposals = paired.map((pair) => pair.proposalIndex);
    const situations = paired.map((pair) => pair.situationId);

    assert.equal(new Set(proposals).size, proposals.length);
    assert.equal(new Set(situations).size, situations.length);
  });

  await t.test("pairing is deterministic across identical inputs", () => {
    // A matcher whose ties break differently between two runs makes every bug
    // in it unreproducible, which for something that silently reassigns
    // identity is the worst possible property.
    const build = (): readonly { readonly situationId: string; readonly proposalIndex: number }[] =>
      pairProposals(
        [{ nodes: refs("a", "b", "c") }, { nodes: refs("a", "b", "d") }],
        [existing("sit_one", "a", "b", "c"), existing("sit_two", "a", "b", "d")],
      ).map((pair) => ({ situationId: pair.situationId, proposalIndex: pair.proposalIndex }));

    assert.deepEqual(build(), build());
  });

  await t.test("nothing proposed pairs nothing", () => {
    assert.equal(pairProposals([], [existing("sit_one", "a", "b")]).length, 0);
  });
});
