// Pets: they move in by themselves for dens being watched, and only the ones home give their perk.
const test = require("node:test");
const assert = require("node:assert/strict");
const S = require("../server.js");
const { BALANCE, PETS, PET_BY_ID, petPerk, addPet, rollCommonPet, rollRunPets, setPets, CATALOG_BY_ID } = S;

const T0 = Date.UTC(2026, 10, 4, 12, 0, 0);
const fresh = (pets = []) => {
  const p = S.newPlayer(1000, T0);
  for (const id of pets) addPet(p, id, T0);
  return p;
};
const always = () => 0, never = () => 0.999;

test("pets: the list is sound", () => {
  assert.equal(PETS.length, 14);
  assert.equal(new Set(PETS.map((q) => q.id)).size, 14);
  for (const q of PETS) {
    assert.ok(["common", "run", "golden"].includes(q.kind), q.id);
    assert.ok(q.says && Object.keys(q.perk).length === 1, q.id);
    if (q.kind === "common") assert.ok(CATALOG_BY_ID.get(q.lure) && CATALOG_BY_ID.get(q.lure).zone, `${q.id} lure`);
  }
  assert.ok(!BALANCE.PETS.SLOTS || BALANCE.PETS.SLOTS === 3);
});

test("pets: a common one needs its lure placed, and comes once", () => {
  const p = fresh();
  assert.equal(rollCommonPet(p, T0, always), null, "no lure, nobody comes");
  p.placed.push({ pid: "b", item: "fur_cardboard_box", x: 2, y: 2, flip: false });
  assert.equal(rollCommonPet(p, T0, never), null, "the roll failed");
  assert.equal(rollCommonPet(p, T0, always), "pet_mouse");
  assert.equal(p.pets.pet_mouse, T0);
  assert.deepEqual(p.petsActive, ["pet_mouse"]);
  assert.equal(rollCommonPet(p, T0, always), null, "never twice");
});

test("pets: the heartbeat rolls for them, only when it stamps", () => {
  const p = fresh();
  p.placed.push({ pid: "b", item: "fur_cardboard_box", x: 2, y: 2, flip: false });
  assert.equal(S.heartbeat(p, T0, always).pet, "pet_mouse");
  delete p.pets.pet_mouse;
  p.petsActive = [];
  assert.equal(S.heartbeat(p, T0 + 1000, always).pet, undefined, "too early: no stamp, no roll");
  assert.ok(!p.pets.pet_mouse);
});

test("pets: running ones only come on watched blocks, and the magpie on golden ones", () => {
  const p = fresh();
  assert.deepEqual(rollRunPets(p, 3, 0, T0, never), []);
  const got = rollRunPets(p, 2, 0, T0, always);
  assert.equal(got.length, 2);
  for (const id of got) assert.equal(PET_BY_ID.get(id).kind, "run");
  assert.ok(!p.pets.pet_magpie);
  assert.deepEqual(rollRunPets(p, 0, 1, T0, always), ["pet_magpie"]);
  assert.deepEqual(rollRunPets(p, 0, 1, T0, always), [], "the magpie comes once");
  const all = fresh();
  assert.equal(rollRunPets(all, 50, 0, T0, always).length, PETS.filter((q) => q.kind === "run").length, "each once");
});

test("pets: accrueAll brings them to watching dens only", () => {
  const st = { players: {}, lastAccruedHeight: 100 };
  const away = fresh(), there = fresh();
  away.joinHeight = there.joinHeight = 100;
  there.lastHeartbeat = T0;
  st.players.a = away;
  st.players.b = there;
  const R = Math.random;
  Math.random = always;
  try { S.accrueAll(st, 103, T0, 100, never); } finally { Math.random = R; }
  assert.deepEqual(away.pets, {});
  assert.ok(Object.keys(there.pets).length >= 1);
});

test("pets: three home at most, and a fourth waits", () => {
  const p = fresh(["pet_mouse", "pet_snail", "pet_cricket", "pet_moth"]);
  assert.deepEqual(p.petsActive, ["pet_mouse", "pet_snail", "pet_cricket"]);
  assert.equal(petPerk(p, "cratesDay"), 0);
  assert.ok(setPets(p, { active: ["pet_moth"] }).ok);
  assert.equal(petPerk(p, "cratesDay"), 1);
  assert.equal(petPerk(p, "wheelPct"), 0);
  assert.equal(setPets(p, { active: ["pet_moth", "pet_mouse", "pet_snail", "pet_cricket"] }).error, "bad_pets", "too many");
  assert.equal(setPets(p, { active: ["pet_moth", "pet_moth"] }).error, "bad_pets", "twice");
  assert.equal(setPets(p, { active: ["pet_shrew"] }).error, "bad_pets", "not yours");
  assert.equal(setPets(p, { active: ["nope"] }).error, "bad_pets");
  assert.equal(setPets(p, {}).error, "bad_pets");
  assert.ok(setPets(p, { active: [] }).ok);
});

test("perk: wheel Watts, from the mouse and the beetle", () => {
  const plain = fresh(), mouse = fresh(["pet_mouse"]), both = fresh(["pet_mouse", "pet_spark_beetle"]);
  const a = S.accrue(plain, 1000, T0), b = S.accrue(mouse, 1000, T0), c = S.accrue(both, 1000, T0);
  assert.equal(b, Math.round(a * 1.01));
  assert.equal(c, Math.round(a * 1.04));
});

test("perk: the snail adds to bed Watts", () => {
  const plain = fresh(), snail = fresh(["pet_snail"]);
  const a = S.bedCredit(plain, 3_600_000, T0), b = S.bedCredit(snail, 3_600_000, T0);
  assert.ok(a > 0);
  assert.equal(b, Math.floor(a * 1.01));
});

test("perk: the cricket adds to the watching bonus, only while watching", () => {
  const p = fresh(["pet_cricket"]);
  assert.equal(S.liveBonusPct(p, T0), 100);
  p.lastHeartbeat = T0;
  assert.equal(S.liveBonusPct(p, T0), BALANCE.LIVE_BONUS_PCT + 1);
});

test("perk: moth and frog stretch the crate limits, firefly the odds", () => {
  const C = BALANCE.CRATES;
  const count = (pets) => {
    const p = fresh(pets);
    S.rollCrates(p, 100, T0, always);
    return p.cratesToday;
  };
  assert.equal(count([]), Math.min(C.PER_DAY, C.MAX_UNOPENED));
  assert.equal(count(["pet_frog"]), Math.min(C.PER_DAY, C.MAX_UNOPENED + 1));
  const moth = fresh(["pet_moth"]);
  moth.cratesToday = C.PER_DAY;
  moth.crateDay = new Date(T0).toISOString().slice(0, 10);
  assert.equal(S.rollCrates(moth, 5, T0, always), 1, "one more than the daily limit");
  const between = () => (C.CHANCE_PCT * 1.1) / 100; // misses without the firefly, hits with it
  assert.equal(S.rollCrates(fresh(), 1, T0, between), 0);
  assert.equal(S.rollCrates(fresh(["pet_firefly"]), 1, T0, between), 1);
});

test("perk: the pigeon pays once a UTC day, on the balance only", () => {
  const p = fresh(["pet_pigeon"]), w = p.watts, life = p.lifetimeWatts;
  assert.equal(S.heartbeat(p, T0, never).pigeon, 200);
  assert.equal(p.watts, w + 200);
  assert.equal(p.lifetimeWatts, life);
  assert.equal(S.heartbeat(p, T0 + 3_600_000, never).pigeon, undefined);
  assert.equal(S.heartbeat(p, T0 + 86_400_000, never).pigeon, 200);
  const q = fresh(), wq = q.watts;
  S.heartbeat(q, T0, never);
  assert.equal(q.watts, wq);
});

test("perk: the gecko lengthens the Raid Shield", () => {
  const st = { players: {} }, tok = "b".repeat(32), p = fresh(["pet_gecko"]);
  st.players[tok] = p;
  p.items.shield_token = 1;
  const r = S.raiseShield(st, tok, { from: "token" }, T0);
  assert.ok(r.ok);
  assert.equal(r.shield.until, T0 + BALANCE.SHIELD.MS + 900_000);
});

test("perk: the ladybug adds 1% to Burrow Drop, not to the Bounty", () => {
  const DropSim = require("../public/drop_sim.js");
  const play = (pets) => {
    const st = { players: {}, drop: { stash: 3000 } }, tok = "c".repeat(32), p = fresh(pets);
    st.players[tok] = p;
    p.watts = 100_000;
    p.drop = { n: 0, lastAt: 0, board: { golden: false, crate: -1, prize: null } };
    return S.playDrop(st, tok, { aim: 120, wager: 1000 }, T0, { seed: 42, rng: never }).result;
  };
  const a = play([]), b = play(["pet_ladybug"]);
  assert.equal(a.slotId, b.slotId);
  if (a.slotId !== "stash") assert.equal(b.land, Math.round(a.land * 1.01));
  assert.ok(DropSim);
});

test("perk: the shrew adds a raid a day", () => {
  const p = fresh(), s = fresh(["pet_shrew"]);
  assert.equal(S.raidsLeft(p, T0), BALANCE.RAID.PER_DAY);
  assert.equal(S.raidsLeft(s, T0), BALANCE.RAID.PER_DAY + 1);
  s.raidDay = new Date(T0).toISOString().slice(0, 10);
  s.raidsToday = BALANCE.RAID.PER_DAY;
  assert.equal(S.raidsLeft(s, T0), 1);
  assert.equal(S.raidsPerDay(s), BALANCE.RAID.PER_DAY + 1);
});

test("perk: the magpie makes golden blocks pay 11x for watchers", () => {
  const plain = fresh(), bird = fresh(["pet_magpie"]);
  plain.lastHeartbeat = bird.lastHeartbeat = T0;
  const a = S.accrue(plain, 1, T0, 100, 1), b = S.accrue(bird, 1, T0, 100, 1);
  assert.equal(b / a, 11 / 10);
});

test("pets: visitors see who's home, and nothing else about them", () => {
  const p = fresh(["pet_mouse"]);
  p.publicId = "abc";
  const den = S.denView({ players: {} }, p, null, T0).den;
  assert.deepEqual(den.petsActive, ["pet_mouse"]);
  assert.equal(den.pets, undefined);
});

test("pets: old saves get the fields", () => {
  const p = fresh();
  delete p.pets;
  delete p.petsActive;
  delete p.pigeonDay;
  S.patchPlayer(p, "d".repeat(32));
  assert.deepEqual(p.pets, {});
  assert.deepEqual(p.petsActive, []);
  assert.equal(p.pigeonDay, null);
});
