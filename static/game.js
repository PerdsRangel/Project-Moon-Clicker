const TICK_MS = 100;
const AUTOSAVE_MS = 15000;
const OFFLINE_EFFICIENCY = 0.5; // fração do ganho que vale enquanto você está fora

let C;        // conteúdo do pacote lobotomy
let S;        // estado do jogador
let player;
let bossTimer = 0;   // segundos restantes do chefe atual
let shownImage = null;   // imagem atualmente carregada
let imageFailed = false; // true se o arquivo não existir
let musicOn = false;       // o jogador quer música?
let musicStarted = false;  // o navegador já liberou o som?
let lastTrack = null;      // faixa tocando: "menu", "normal" ou "boss"
let inGame = false;        // false enquanto o menu está aberto
let inRaid = false;        // a tela de Boss Raid está aberta?
let raid = null;           // luta em andamento: { boss, hp, maxHp, time, result }
let dropList = [];         // todos os equipamentos do jogo
let buyMode = 1;           // quantidade por compra: 1, 10, 25 ou "max"
let raidAuto = false;      // reiniciar a raid sozinho ao terminar?
let raidSession = null;    // resumo da sessão de farm do boss atual
let raidSessionId = 0;
let lastSave = 0;          // última gravação rápida (limita as gravações em vitórias seguidas)
let logKey = "";
let inDept = false;        // a tela de Departamentos está aberta?
let deptB = {};            // bônus somados dos departamentos, por tipo de efeito
let deptCards = [];
let angelaQueue = [];      // falas esperando para aparecer
let angelaShowing = false;
let angelaTimer = null;
let angelaType = null;

const $ = (id) => document.getElementById(id);

const SUFFIXES = ["", "K", "M", "B", "T", "Qa", "Qi", "Sx", "Sp", "Oc", "No", "Dc"];

function fmt(n) {
  if (n < 10) return n.toFixed(1).replace(".", ",");
  if (n < 1e6) return Math.floor(n).toLocaleString("pt-BR");
  const tier = Math.floor(Math.log10(n) / 3);
  if (tier >= SUFFIXES.length) return n.toExponential(2).replace("e+", "e");
  return (n / Math.pow(1000, tier)).toFixed(2).replace(".", ",") + SUFFIXES[tier];
}

function newState() {
    return { version: 1, stage: 1, maxStage: 1, cleared: 0, equip: {}, raidEnk: 0, raidUp: {}, skills: {}, skillAuto: {}, seen: {}, raidWins: 0, deptOpened: false, dept: {}, enk: 0, clickLvl: 0, agents: {}, hp: 0, maxHp: 0, auto: true, ordeals: {}, };
}

/* ---------- regras ---------- */

const isBoss = (n) => n % C.stage.boss_every === 0;

function stageHp(n) {
  const base = C.stage.hp_base * Math.pow(C.stage.hp_growth, n - 1);
  return isBoss(n) ? base * C.stage.boss_hp_mult : base;
}

function monsterFor(n) {
  if (isBoss(n)) {
    const i = n / C.stage.boss_every - 1;
    return C.bosses[i % C.bosses.length];
  }
  // conta só as fases normais, sem as fases de chefe
  const i = n - 1 - Math.floor(n / C.stage.boss_every);
  return C.abnormalities[i % C.abnormalities.length];
}

const clickMult = () => Math.pow(C.click.milestone_mult, Math.floor(S.clickLvl / C.click.milestone_every));
const clickDamage = () => C.click.base_damage * (1 + S.clickLvl) * clickMult() * dmgMult() + dps() * C.click.dps_share;
const clickCost = () => C.click.base_cost * Math.pow(C.click.cost_growth, S.clickLvl);
const agentLvl = (a) => S.agents[a.id] || 0;
const agentCost = (a) => a.base_cost * Math.pow(C.agent_cost_growth, agentLvl(a));
const agentMult = (a) => Math.pow(C.milestone.mult, Math.floor(agentLvl(a) / C.milestone.every));
const raidUpBonus = () => (C.raid_upgrades || []).reduce((sum, u) => sum + (S.raidUp[u.id] || 0) * u.bonus, 0);
const dmgMult = () => (1 + raidUpBonus() + dB("damage") + dropList.reduce((sum, d) => sum + (S.equip[d.id] ? d.bonus : 0), 0)) * skillMult("damage");
const agentDmg = (a) => a.base_dps * agentLvl(a) * agentMult(a) * dmgMult();
const dps = () => C.agents.reduce((sum, a) => sum + agentDmg(a), 0);

const typeName = (d) => (d.type === "weapon" ? "Arma" : d.type === "armor" ? "Armadura" : d.type === "gift" ? "Ego Gift" : "Item");
const pctText = (x) => String(+(x * 100).toFixed(1)) + "%";

// itens padrão (placeholder) de cada raid boss; para personalizar, use "drops" no JSON
function dropsOf(boss, i) {
  if (boss.drops) return boss.drops;
  const n = "raid" + (i + 1);
  return [
    { id: n + "-arma", type: "weapon", name: "Arma (nome a definir)", image: "", chance: 0.05, bonus: 0.20 },
    { id: n + "-armadura", type: "armor", name: "Armadura (nome a definir)", image: "", chance: 0.10, bonus: 0.10 },
    { id: n + "-gift", type: "armor", name: "Gift (nome a definir)", image: "", chance: 0.01, bonus: 0.50 },
  ];
}

const raidOpen = (unlock) => S.cleared >= unlock;

function allDrops() {
  const every = C.raid_unlock_every || 10;
  const raids = (C.raidbosses || []).flatMap((b, i) =>
    b.drops.map((d) => Object.assign({ from: b.name, unlock: (i + 1) * every }, d))
  );
  const ordeals = (C.ordeals || []).flatMap((o) =>
    (o.drops || []).map((d) => Object.assign({ from: o.name, unlock: o.stage }, d))
  );
  return raids.concat(ordeals);
}

function rollDrops(boss) {
  const got = [];
  boss.drops.forEach((d) => {
    if (!S.equip[d.id] && Math.random() < d.chance * (1 + dB("drop_chance"))) {
      S.equip[d.id] = true;
      got.push(d);
    }
  });
  return got;
}

function skillState(s) {
  if (!S.skills[s.id]) S.skills[s.id] = { until: 0, readyAt: 0 };
  return S.skills[s.id];
}

function skillMult(effect) {
  const t = Date.now();
  return (C.skills || []).reduce(
    (m, s) => (s.effect === effect && t < skillState(s).until && !(raid && raid.sealed === s.id) ? m * s.mult : m),
    1
  );
}

const skillUnlocked = (s) => S.cleared >= (s.unlock_stage || 0);

function useSkill(s) {
  if (raid && raid.sealed === s.id) return;
  if (!skillUnlocked(s)) return;
  const st = skillState(s);
  const t = Date.now();
  if (t < st.readyAt) return;
  if (s.cost_pct) S.enk -= S.enk * (s.cost_pct / 100);
  st.until = t + s.duration * 1000;
  st.readyAt = t + s.cooldown * 1000 * Math.max(0.3, 1 - dB("cooldown"));
  render();
}

function autoSkills() {
  // na raid, só usa durante uma luta em andamento; o bônus de dinheiro não vale lá
  if (inRaid && (!raid || raid.result)) return;
  const t = Date.now();
  (C.skills || []).forEach((s) => {
    if (!S.skillAuto[s.id] || !skillUnlocked(s)) return;
    if (inRaid && s.effect === "money") return;
    if (t >= skillState(s).readyAt) useSkill(s);
  });
}
const durText = (sec) => (sec >= 60 && sec % 60 === 0 ? sec / 60 + " min" : sec + " s");
const clock = (sec) => (sec >= 60 ? Math.floor(sec / 60) + ":" + String(sec % 60).padStart(2, "0") : sec + "s");

function skillText(s) {
  if (s.description) return s.description;
  const what = s.effect === "money" ? "o dinheiro ganho" : "o DPS total";
  let t = "Aumenta " + what + " em " + s.mult + "x durante " + durText(s.duration) + ". Recarga: " + durText(s.cooldown) + ".";
  if (s.cost_pct) t += " Custa " + s.cost_pct + "% do dinheiro atual.";
  return t;
}

function spawn() {
  S.maxHp = stageHp(S.stage);
  S.hp = S.maxHp;
  bossTimer = isBoss(S.stage) ? C.stage.boss_time + dB("boss_time") : 0;
}

function damage(amount) {
  S.hp -= amount;
  if (S.hp <= 0) {
    const last = C.stage.max_stage || Infinity;
    const finished = S.stage > S.cleared && S.stage === last;
    S.enk += S.maxHp * C.stage.reward_ratio * skillMult("money") * (1 + dB("money"));
    S.cleared = Math.max(S.cleared, S.stage);
    S.maxStage = Math.max(S.maxStage, Math.min(S.stage + 1, last));
    if (S.auto && S.stage < last) S.stage += 1;
    if (finished) $("msg").textContent = "Você concluiu todas as " + last + " fases!";
    spawn();
  }
}

/* dano recente por fonte ("click" ou o id de cada agente), com decaimento */
const recent = {};

function record(src, amount) {
  recent[src] = (recent[src] || 0) + amount;
}

function decayRecent(dt) {
  const k = Math.pow(0.5, dt / 5); // o peso cai pela metade a cada 5 s
  for (const src in recent) recent[src] *= k;
}

function share(src) {
  const total = Object.values(recent).reduce((a, b) => a + b, 0);
  return total > 0 ? ((recent[src] || 0) / total) * 100 : 0;
}

function agentTick(dt) {
  C.agents.forEach((a) => {
    const d = agentDmg(a) * dt;
    if (d > 0) {
      record(a.id, d);
      damage(d);
    }
  });
}

function tickBoss(dt) {
  if (!isBoss(S.stage)) return;
  bossTimer -= dt;
  if (bossTimer <= 0) {
    if (S.auto) {
      S.stage = Math.max(1, S.stage - 1);
      $("msg").textContent = "A Abnormalidade escapou! Você recuou para a fase " + S.stage + ".";
    } else {
      $("msg").textContent = "A Abnormalidade se regenerou. Tente de novo!";
    }
    spawn();
  }
}

/* ---------- interface ---------- */

function buildShop() {
  const shop = $("shop");
  shop.innerHTML = "";
  const rows = [{ id: "click", label: "Treino de Supressão" }].concat(
    C.agents.map((a) => ({ id: a.id, label: a.name }))
  );
  rows.forEach((r) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "buy";
    b.id = "buy-" + r.id;
    b.innerHTML = '<span><span class="t"></span><span class="bonus"></span><small></small></span><span class="cost"></span>';
    b.addEventListener("click", () => buy(r.id));
    shop.appendChild(b);
  });
}

// custo de comprar n níveis de uma vez (soma de uma progressão geométrica)
function geoCost(base, growth, lvl, n) {
  return (base * Math.pow(growth, lvl) * (Math.pow(growth, n) - 1)) / (growth - 1);
}

function maxAffordable(base, growth, lvl, budget) {
  const first = base * Math.pow(growth, lvl);
  let n = Math.floor(Math.log(1 + (budget * (growth - 1)) / first) / Math.log(growth));
  if (!isFinite(n) || n < 0) n = 0;
  while (n > 0 && geoCost(base, growth, lvl, n) > budget) n--; // segurança contra arredondamento
  return n;
}

function plan(base, growth, lvl) {
  let n = buyMode === "max" ? maxAffordable(base, growth, lvl, S.enk) : buyMode;
  if (n < 1) n = 1;
  return { n, cost: geoCost(base, growth, lvl, n) };
}

function rowPlan(id) {
  if (id === "click") return plan(C.click.base_cost, C.click.cost_growth, S.clickLvl);
  const a = C.agents.find((x) => x.id === id);
  return plan(a.base_cost * Math.max(0.2, 1 - dB("agent_cost")), C.agent_cost_growth, agentLvl(a));
}

function buy(id) {
  const p = rowPlan(id);
  if (S.enk < p.cost) return;
  S.enk -= p.cost;
  if (id === "click") S.clickLvl += p.n;
  else S.agents[id] = (S.agents[id] || 0) + p.n;
  render();
}

const fmtMult = (m) => (m < 1000 ? m.toLocaleString("pt-BR") : fmt(m));
const fmtPct = (p) => (p > 0 && p < 1 ? "<1%" : Math.round(p) + "%");

function setRow(id, title, sub, p, bonus) {
  const b = $("buy-" + id);
  b.querySelector(".t").textContent = title;
  b.querySelector(".bonus").textContent = bonus || "";
  b.querySelector("small").textContent = sub;
  b.querySelector(".cost").textContent = (p.n > 1 ? "x" + p.n + " · " : "") + fmt(p.cost);
  b.disabled = S.enk < p.cost;
}

function syncMusic(force) {
  const track = !inGame ? "menu" : (raid ? "raid" : (isBoss(S.stage) ? "boss" : "normal"));
  if (!force && track === lastTrack) return;
  const changed = track !== lastTrack;
  lastTrack = track;

  const audios = { menu: $("bgm-menu"), normal: $("bgm"), boss: $("bgm-boss"), raid: $("bgm-raid") };
  if (!(musicOn && musicStarted)) {
    Object.values(audios).forEach((a) => a.pause());
    return;
  }

  Object.entries(audios).forEach(([name, a]) => { if (name !== track) a.pause(); });
  const want = audios[track];
  if ((track === "boss" || track === "raid") && changed) want.currentTime = 0;
  if (want.paused) want.play().catch(() => {});
}

let raidRows = [];

function buildRaidList() {
  const list = $("raid-list");
  list.innerHTML = "";
  raidRows = [];
  const bosses = C.raidbosses || [];
  if (bosses.length === 0) {
    list.textContent = "Nenhum chefe de raid cadastrado ainda.";
    return;
  }
  const every = C.raid_unlock_every || 10;
  bosses.forEach((boss, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "buy";
    b.innerHTML = '<span><span class="t"></span><small></small><small class="drops"></small></span><span class="cost"></span>';
    b.querySelector(".t").textContent = boss.name;
    b.querySelector("small").textContent = boss.risk + (boss.waves && boss.waves.length ? " · " + boss.waves.length + " inimigos + chefe" : "");
    b.addEventListener("click", () => startRaid(boss));
    list.appendChild(b);
    raidRows.push({ el: b, boss, unlock: (i + 1) * every });
  });
}

function updateRaidList() {
  raidRows.forEach((r) => {
    const open = raidOpen(r.unlock);
    r.el.disabled = !open;
    r.el.querySelector(".cost").textContent = open
      ? (r.boss.waves && r.boss.waves.length ? "HP total " : "HP ") + fmt(raidTotalHp(r.boss))
      : "Derrote a fase " + r.unlock;
    r.el.querySelector(".drops").textContent = r.boss.drops
      .map((d) => typeName(d) + " " + pctText(d.chance) + (S.equip[d.id] ? " ✓" : ""))
      .join(" · ");
  });
}

function openRaid() { inRaid = true; raid = null; updateRaidList(); render(); }
function closeRaid() { inRaid = false; raid = null; render(); }

const raidTotalHp = (b) =>
  (b.waves || []).reduce((sum, w) => sum + (w.hp || 10000), 0) + (b.raid_hp || 100000);

function setRaidEnemy() {
  const e = raid.enemies[raid.index];
  raid.maxHp = e.hp;
  raid.hp = e.hp;
  const img = $("raid-sprite");
  img.hidden = !e.image;
  if (e.image) img.src = "/static/img/" + e.image;
}

function startRaid(boss, keep) {
  if (!keep || !raidSession || raidSession.boss !== boss) {
    raidSession = { id: ++raidSessionId, boss, runs: 0, wins: 0, coins: 0, items: {}, log: [] };
  }
  const enemies = (boss.waves || [])
  .map((w) => ({
    name: w.name, risk: w.risk, image: w.image, hp: w.hp || 10000, isBoss: false,
    background: w.background || boss.waves_background || boss.background || null,
  }))
  .concat([{
    name: boss.name, risk: boss.risk, image: boss.image, hp: boss.raid_hp || 100000, isBoss: true,
    background: boss.background || null,
  }]);
  // carrega os fundos antes, para não piscar na troca de inimigo
  if (!keep) enemies.forEach((e) => { if (e.background) new Image().src = "/static/img/" + encodeURIComponent(e.background); });
  raid = { boss, enemies, index: 0, maxHp: 0, hp: 0, time: (boss.time || C.raid_time || 60) + dB("boss_time"), result: null, drops: [], coins: 0, restartIn: null };
  setRaidEnemy();
  render();
}

function raidDamage(amount) {
  if (!raid || raid.result) return;
  raid.hp -= amount;
  if (raid.hp > 0) return;
  if (raid.index < raid.enemies.length - 1) {
    raid.index += 1;
    setRaidEnemy();
    return;
  }
  raid.hp = 0;
  raid.result = "win";
  if (raid.kind === "ordeal") { finishOrdeal(); return; }
  S.raidWins = (S.raidWins || 0) + 1;
  raid.coins = raid.boss.raid_coins || 5;
  S.raidEnk += raid.coins;
  raid.drops = rollDrops(raid.boss);
  logRaid("win");
  saveSoon();
}

function tickRaid(dt) {
  if (!raid) return;
  if (raid.result) {
    if (raidAuto && raid.kind !== "ordeal") startRaid(raid.boss, true); // reinicia na hora
    return;
  }
  raidDamage(dps() * dt);
  raid.time -= dt;
  if (raid.result === null && raid.time <= 0) {
    raid.time = 0;
    raid.result = "lose";
    if (raid.kind === "ordeal") {
      if (raid.ordeal.say) angelaSay(raid.ordeal.say.lose, true);
    } else {
      logRaid("lose");
    }
  }
}

let raidBg = null;

function setRaidBackground(file) {
  if (file === raidBg) return;
  raidBg = file;
  const el = $("raid");
  el.style.backgroundImage = file
    ? 'linear-gradient(rgba(20, 23, 26, 0.6), rgba(20, 23, 26, 0.8)), url("/static/img/' + encodeURIComponent(file) + '")'
    : "";
  el.style.backgroundSize = file ? "cover" : "";
  el.style.backgroundPosition = file ? "center" : "";
}

const fmtCoin = (n) => (n < 1e6 ? Math.floor(n).toLocaleString("pt-BR") : fmt(n));
const raidUpLvl = (u) => S.raidUp[u.id] || 0;
const raidUpCost = (u) => Math.ceil(u.base_cost * Math.pow(u.cost_growth || 1.5, raidUpLvl(u)));

let raidShopRows = [];

function buildRaidShop() {
  const box = $("raid-shop");
  box.innerHTML = "";
  raidShopRows = [];
  const ups = C.raid_upgrades || [];
  if (ups.length === 0) {
    box.textContent = "Nenhum upgrade cadastrado ainda.";
    return;
  }
  ups.forEach((u) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "buy";
    b.innerHTML = '<span><span class="t"></span><small></small></span><span class="cost"></span>';
    b.querySelector(".t").textContent = u.name;
    b.addEventListener("click", () => buyRaidUpgrade(u));
    box.appendChild(b);
    raidShopRows.push({ el: b, u });
  });
}

function buyRaidUpgrade(u) {
  const lvl = raidUpLvl(u);
  if (u.max_level && lvl >= u.max_level) return;
  const cost = raidUpCost(u);
  if (S.raidEnk < cost) return;
  S.raidEnk -= cost;
  S.raidUp[u.id] = lvl + 1;
  render();
}

function renderRaidShop() {
  $("raid-coins").textContent = fmtCoin(S.raidEnk);
  raidShopRows.forEach(({ el, u }) => {
    const lvl = raidUpLvl(u);
    const maxed = !!u.max_level && lvl >= u.max_level;
    const cost = raidUpCost(u);
    el.querySelector("small").textContent =
      "+" + pctText(u.bonus) + " de dano por nível · Nível " + lvl + (u.max_level ? "/" + u.max_level : "") +
      " · total +" + pctText(lvl * u.bonus);
    el.querySelector(".cost").textContent = maxed ? "MAX" : fmtCoin(cost);
    el.disabled = maxed || S.raidEnk < cost;
  });
}

function saveSoon() {
  const now = Date.now();
  if (now - lastSave < 5000) return; // no máximo uma gravação a cada 5 s
  lastSave = now;
  save(false);
}

function logRaid(result) {
  const ss = raidSession;
  ss.runs += 1;
  if (result === "win") {
    ss.wins += 1;
    ss.coins += raid.coins;
    raid.drops.forEach((d) => { ss.items[d.name] = (ss.items[d.name] || 0) + 1; });
  }
}

function renderRaidLog() {
  const ss = raidSession;
  if (!ss) return;
  const key = ss.id + ":" + ss.runs + ":" + ss.coins;
  if (key === logKey) return;
  logKey = key;
  const items = Object.entries(ss.items).map(([n, c]) => n + (c > 1 ? " x" + c : "")).join(", ");
  $("raid-summary").textContent =
    ss.runs + " lutas · " + ss.wins + " vitórias · +" + fmtCoin(ss.coins) + " Caixas de Enkephalin Raid" +
    (items ? " · Itens: " + items : "");
}

const RULE_TEXT = {
  green: "Muitos inimigos em sequência.",
  crimson: "O tempo é curto.",
  violet: "Uma habilidade foi selada.",
  amber: "Cada onda é mais forte que a anterior.",
};

function ordealRules(r) {
  let t = (r.ordeal.rules || []).map((k) => RULE_TEXT[k] || k).join(" ");
  if (r.sealed) {
    const s = (C.skills || []).find((x) => x.id === r.sealed);
    t += " Selada: " + (s ? s.name : r.sealed) + ".";
  }
  return t;
}

function angelaSay(t, pickOne) {
  if (!t) return;
  let parts = Array.isArray(t) ? t : [t];
  if (pickOne) parts = [parts[Math.floor(Math.random() * parts.length)]];
  parts.forEach((x) => angelaQueue.push(x.replace(/\{jogador\}/g, () => player)));
  if (!angelaShowing && angelaQueue.length) showNextAngela();
}

// o Ordeal da fase atual, se ainda não foi vencido (bloqueia o avanço)
function pendingOrdeal() {
  return (C.ordeals || []).find((o) => o.stage === S.stage && !S.ordeals[o.id]) || null;
}

function startOrdeal(o) {
  const base = stageHp(o.stage);
  const amber = (o.rules || []).includes("amber");
  const list = (o.enemies || []).flatMap((e) =>
    Array.from({ length: e.count || 1 }, (_, k) =>
      Object.assign({}, e, { name: (e.count || 1) > 1 ? e.name + " " + (k + 1) : e.name })
    )
  );
  const enemies = list.map((e, i) => ({
    name: e.name,
    risk: e.risk || o.color,
    image: e.image,
    isBoss: i === list.length - 1,
    hp: base * (e.hp_mult || 0.1) * (amber ? 1 + 0.3 * i : 1),
    background: e.background || o.background || null,
  }));
  raid = {
    kind: "ordeal", ordeal: o, boss: o, enemies, index: 0, maxHp: 0, hp: 0,
    time: (o.time || 60) + dB("boss_time"), result: null, drops: [], coins: 0, restartIn: null, sealed: null,
  };
  if ((o.rules || []).includes("violet")) {
    const pool = (C.skills || []).filter((s) => skillUnlocked(s) && s.effect !== "money");
    if (pool.length) raid.sealed = pool[Math.floor(Math.random() * pool.length)].id;
  }
  inRaid = true;
  setRaidEnemy();
  if (o.say) angelaSay(o.say.start);
  render();
}

function finishOrdeal() {
  const o = raid.ordeal;
  const last = C.stage.max_stage || Infinity;
  S.ordeals[o.id] = true;
  S.cleared = Math.max(S.cleared, o.stage);
  S.maxStage = Math.max(S.maxStage, Math.min(o.stage + 1, last));
  if (S.stage === o.stage && o.stage < last) {
    S.stage = o.stage + 1;
    spawn();
  }
  raid.drops = rollDrops(o);
  save(false);
  if (o.say) angelaSay(o.say.win);
  if (o.stage === last) $("msg").textContent = "Você concluiu todas as " + last + " fases!";
}

function renderRaid() {
  setRaidBackground(raid ? raid.enemies[raid.index].background : null);
  $("raid-select").hidden = !!raid;
  $("raid-fight").hidden = !raid;
  if (!raid) { renderRaidShop(); return; }

  const ordeal = raid.kind === "ordeal";
  const e = raid.enemies[raid.index];
  $("raid-name").textContent = e.name;
  $("raid-risk").textContent = e.risk + (e.isBoss ? (ordeal ? " (Ordeal)" : " (Boss Raid)") : "");
  $("raid-monster").classList.toggle("boss", e.isBoss);
  $("raid-monster").style.borderColor = ordeal ? (raid.ordeal.hex || "") : "";
  $("raid-progress").textContent =
    (raid.enemies.length > 1 ? "· Inimigo " + (raid.index + 1) + " de " + raid.enemies.length : "") +
    (ordeal ? " · " + raid.ordeal.name : "");
  $("raid-time").textContent = Math.ceil(raid.time);
  $("raid-hp-fill").style.width = Math.max(0, (raid.hp / raid.maxHp) * 100) + "%";
  $("raid-hp-text").textContent = fmt(Math.max(0, raid.hp)) + " / " + fmt(raid.maxHp) + " HP";

  const res = $("raid-result");
  const dropText = raid.drops.length
    ? " Drop: " + raid.drops.map((d) => d.name).join(", ") + "!"
    : (ordeal ? "" : " Nenhum drop desta vez.");
  if (raid.result === "win") {
    res.textContent = ordeal
      ? "Ordeal concluído! +" + (raid.ordeal.points || 0) + " pontos de departamento." + dropText
      : "Chefe derrotado! +" + fmtCoin(raid.coins) + " Caixas de Enkephalin Raid." + dropText;
  } else if (raid.result === "lose") {
    res.textContent = ordeal ? "O Ordeal prevaleceu. Tente de novo." : "O tempo acabou. O chefe escapou.";
  } else {
    res.textContent = ordeal ? ordealRules(raid) : "";
  }
  res.className = "raid-result" + (raid.result ? " " + raid.result : "");
  $("raid-retry").hidden = !raid.result;
  $("raid-back").textContent = ordeal ? "Voltar ao jogo" : "Escolher outro chefe";
  $("raid-monster").disabled = !!raid.result;
  $("raid-auto").parentElement.style.display = ordeal ? "none" : "";
  document.querySelector(".raid-log").style.display = ordeal ? "none" : "";
  if (!ordeal) renderRaidLog();
}

function goToStage(n) {
  if (n < 1 || n > S.maxStage || n === S.stage) return;
  S.stage = n;
  spawn();
  $("msg").textContent = "";
  render();
}

let navKey = "";

function renderNav() {
  // só reconstrói quando a fase muda, para não perder cliques nos botões
  const key = S.stage + ":" + S.maxStage;
  if (key === navKey) return;
  navKey = key;

  const nav = $("stage-nav");
  nav.innerHTML = "";

  const add = (label, target, cls, disabled, aria) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip" + (cls ? " " + cls : "");
    b.textContent = label;
    b.disabled = disabled;
    if (aria) b.setAttribute("aria-label", aria);
    b.addEventListener("click", () => goToStage(target));
    nav.appendChild(b);
  };

  add("‹", S.stage - 1, "", S.stage <= 1, "Fase anterior");
  const last = C.stage.max_stage || Infinity;
  const start = Math.max(1, Math.min(S.stage - 2, last - 4));
  for (let n = start; n < start + 5 && n <= last; n++) {
    const cls = ((n === S.stage ? "current " : "") + (isBoss(n) ? "boss" : "")).trim();
    add(String(n), n, cls, n > S.maxStage, "Fase " + n);
  }
  add("›", S.stage + 1, "", S.stage >= S.maxStage, "Próxima fase");
  add("»", S.maxStage, "", S.stage >= S.maxStage, "Ir para a fase mais alta");
}

let equipRows = [];
let equipKey = null;

function buildEquip() {
  const box = $("equip");
  box.innerHTML = "";
  equipKey = null;
  equipRows = dropList.map((d) => {
    const row = document.createElement("div");
    row.className = "equip-item locked";
    row.innerHTML = '<div class="equip-icon"><img alt="" draggable="false" hidden></div><div><div class="equip-name"></div><small></small></div>';
    const img = row.querySelector("img");
    if (d.image) {
      img.src = "/static/img/" + d.image;
      img.hidden = false;
    }
    img.addEventListener("error", () => { img.hidden = true; });
    row.querySelector(".equip-name").textContent = d.name;
    box.appendChild(row);
    return { row, d };
  });
  const empty = document.createElement("p");
  empty.id = "equip-empty";
  empty.className = "msg";
  empty.textContent = "Nenhum equipamento disponível. Desbloqueie as Raids para liberá-los.";
  box.appendChild(empty);
}

function renderEquip() {
  // só atualiza quando os itens obtidos ou o progresso mudam
  const owned = Object.keys(S.equip).filter((k) => S.equip[k]).sort().join(",");
  const key = owned + "|" + S.cleared;
  if (key === equipKey) return;
  equipKey = key;

  let visible = 0;
  equipRows.forEach(({ row, d }) => {
    const has = !!S.equip[d.id];
    const show = has || raidOpen(d.unlock);
    row.style.display = show ? "" : "none";
    if (show) visible++;
    row.classList.toggle("locked", !has);
    row.querySelector("small").textContent = has
      ? typeName(d) + " · +" + pctText(d.bonus) + " de dano"
      : typeName(d) + " · dropa de " + d.from;
  });
  $("equip-empty").hidden = visible > 0;
}

let skillEls = [];
let masterEls = [];

function toggleAllAuto() {
  const skills = C.skills || [];
  const on = !skills.every((s) => S.skillAuto[s.id]);
  skills.forEach((s) => { S.skillAuto[s.id] = on; });
  render();
}

function buildSkills() {
  skillEls = [];
  masterEls = [];
  const hasAlly = (C.skills || []).some((s) => s.ally_image);
  ["skills", "raid-skills"].forEach((boxId) => {
    const box = $(boxId);
    if (!box) return;
    box.innerHTML = "";
    box.classList.toggle("has-ally", hasAlly);
    const master = document.createElement("button");
    master.type = "button";
    master.className = "skills-all";
    master.textContent = "AUTO";
    master.title = "Ativar todas as habilidades automaticamente";
    master.setAttribute("aria-pressed", "false");
    master.addEventListener("click", toggleAllAuto);
    box.appendChild(master);
    box.classList.add("has-master");
    masterEls.push(master);
    (C.skills || []).forEach((s) => {
      if (boxId === "raid-skills" && s.effect === "money") return;
      const wrap = document.createElement("div");
      wrap.className = "skill";
      wrap.innerHTML =
        '<div class="skill-name"></div>' +
        '<div class="skill-row">' +
          '<button type="button" class="skill-box"><img alt="" draggable="false" hidden><span class="skill-timer" hidden></span></button>' +
          '<button type="button" class="skill-auto" aria-pressed="false" title="Usar automaticamente quando disponível">AUTO</button>' +
        '</div>' +
        '<div class="skill-tip" role="tooltip"></div>' +
        (s.ally_image ? '<img class="skill-ally" alt="" draggable="false" hidden>' : "");
      wrap.querySelector(".skill-name").textContent = s.name;

      const img = wrap.querySelector(".skill-box img");
      if (s.image) {
        img.src = "/static/img/" + s.image;
        img.hidden = false;
      }
      img.addEventListener("error", () => { img.hidden = true; });

      const ally = wrap.querySelector(".skill-ally");
      if (ally) {
        ally.src = "/static/img/" + s.ally_image;
        ally.addEventListener("error", () => { ally.dataset.broken = "1"; ally.hidden = true; });
      }

      wrap.querySelector(".skill-box").addEventListener("click", () => useSkill(s));
      wrap.querySelector(".skill-auto").addEventListener("click", () => {
        S.skillAuto[s.id] = !S.skillAuto[s.id];
        render();
      });
      box.appendChild(wrap);
      skillEls.push({ wrap, s, unlocked: undefined });
    });
  });
}

function renderSkills() {
  const all = C.skills || [];
  const allOn = all.length > 0 && all.every((s) => S.skillAuto[s.id]);
  masterEls.forEach((b) => {
    b.classList.toggle("on", allOn);
    b.setAttribute("aria-pressed", allOn ? "true" : "false");
    b.parentElement.classList.toggle("all-on", allOn);
  });
  const t = Date.now();
  skillEls.forEach((el) => {
    const { wrap, s } = el;
    const st = skillState(s);
    const unlocked = skillUnlocked(s);
    const active = unlocked && t < st.until;
    const cooling = unlocked && t < st.readyAt;
    const timer = wrap.querySelector(".skill-timer");
    const autoBtn = wrap.querySelector(".skill-auto");
    const on = !!S.skillAuto[s.id];

    wrap.classList.toggle("locked", !unlocked);
    wrap.classList.toggle("active", active);
    wrap.classList.toggle("cooling", cooling);
    const sealed = !!(raid && raid.sealed === s.id);
    wrap.classList.toggle("sealed", sealed);
    timer.hidden = unlocked && !cooling && !sealed;
    if (!unlocked) timer.textContent = "Fase " + s.unlock_stage;
    else if (sealed) timer.textContent = "Selada";
    else if (cooling) timer.textContent = clock(Math.ceil(((active ? st.until : st.readyAt) - t) / 1000));

    autoBtn.classList.toggle("on", on);
    autoBtn.setAttribute("aria-pressed", on ? "true" : "false");
    autoBtn.disabled = !unlocked;

    if (el.unlocked !== unlocked) {
      el.unlocked = unlocked;
      wrap.querySelector(".skill-tip").textContent =
        (unlocked ? "" : "Libera ao completar a fase " + s.unlock_stage + ". ") + skillText(s);
    }

    const ally = wrap.querySelector(".skill-ally");
    if (ally) ally.hidden = !(active && ally.dataset.broken !== "1");
  });
}

const dB = (effect) => deptB[effect] || 0;
const deptLvl = (n) => S.dept[n.id] || 0;
const nodeCost = (n) => (n.cost || 1) + (n.cost_step || 0) * deptLvl(n);
const deptUnlocked = (d) => S.cleared >= (d.unlock_stage || 0);

function nodeOpen(d, i) {
  if (i === 0) return true;
  const prev = d.nodes[i - 1];
  return deptLvl(prev) >= Math.min(d.chain_level || 3, prev.max_level);
}

function deptPointsEarned() {
  const p = C.department_points || { per_stage: 1, per_boss_stage: 2 };
  const ordeal = (C.ordeals || []).reduce((s, o) => s + (S.ordeals[o.id] ? (o.points || 0) : 0), 0);
  return S.cleared * (p.per_stage || 0) + Math.floor(S.cleared / C.stage.boss_every) * (p.per_boss_stage || 0) + ordeal;
}

function deptPointsSpent() {
  let sum = 0;
  (C.departments || []).forEach((d) => d.nodes.forEach((n) => {
    for (let k = 0; k < deptLvl(n); k++) sum += (n.cost || 1) + (n.cost_step || 0) * k;
  }));
  return sum;
}

const deptPoints = () => deptPointsEarned() - deptPointsSpent();

function recalcDept() {
  deptB = {};
  (C.departments || []).forEach((d) => d.nodes.forEach((n) => {
    deptB[n.effect] = (deptB[n.effect] || 0) + deptLvl(n) * n.bonus;
  }));
}

function effText(n, b) {
  switch (n.effect) {
    case "money": return "+" + pctText(b) + " de enkephalin ganho";
    case "damage": return "+" + pctText(b) + " de dano total";
    case "agent_cost": return "-" + pctText(b) + " no custo dos agentes";
    case "boss_time": return "+" + +b.toFixed(1) + " s de tempo em chefes e raids";
    case "cooldown": return "-" + pctText(b) + " na recarga das habilidades";
    case "drop_chance": return "+" + pctText(b) + " de chance de drop";
    case "offline": return "+" + pctText(b) + " de ganho offline";
    default: return n.effect + " " + b;
  }
}

function buildDept() {
  const list = $("dept-list");
  list.innerHTML = "";
  deptCards = [];
  (C.departments || []).forEach((d) => {
    const card = document.createElement("div");
    card.className = "dept-card";
    if (d.color) card.style.setProperty("--dept", d.color);
    card.innerHTML =
      '<div class="dept-head"><img class="dept-icon" alt="" draggable="false" hidden><div><div class="dept-name"></div><small></small></div></div>' +
      '<p class="dept-desc"></p><div class="dept-nodes"></div><p class="dept-lock" hidden></p>';
    card.querySelector(".dept-name").textContent = d.name;
    card.querySelector("small").textContent = d.sephirah || "";
    card.querySelector(".dept-desc").textContent = d.description || "";
    const icon = card.querySelector(".dept-icon");
    if (d.image) {
      icon.src = "/static/img/" + d.image;
      icon.hidden = false;
    }
    icon.addEventListener("error", () => { icon.hidden = true; });

    const nodesBox = card.querySelector(".dept-nodes");
    const rows = d.nodes.map((n, i) => {
      const el = document.createElement("button");
      el.type = "button";
      el.className = "buy";
      el.innerHTML = '<span><span class="t"></span><small></small></span><span class="cost"></span>';
      el.addEventListener("click", () => buyNode(d, i));
      nodesBox.appendChild(el);
      return { n, el };
    });
    list.appendChild(card);
    deptCards.push({ d, card, rows, lockEl: card.querySelector(".dept-lock") });
  });
}

function renderDept() {
  const points = deptPoints();
  $("dept-points").textContent = fmtCoin(points);
  $("dept-earned").textContent = "(" + fmtCoin(deptPointsEarned()) + " ganhos no total)";
  deptCards.forEach(({ d, card, rows, lockEl }) => {
    const open = deptUnlocked(d);
    card.classList.toggle("locked", !open);
    lockEl.hidden = open;
    lockEl.textContent = "Libera ao completar a fase " + d.unlock_stage + ".";
    rows.forEach(({ n, el }, i) => {
      const lvl = deptLvl(n);
      const maxed = lvl >= n.max_level;
      const reached = open && nodeOpen(d, i);
      const cost = nodeCost(n);
      el.querySelector(".t").textContent = n.name + " · " + lvl + "/" + n.max_level;
      if (!reached) {
        const prev = d.nodes[i - 1];
        el.querySelector("small").textContent = prev
          ? "Requer " + prev.name + " no nível " + Math.min(d.chain_level || 3, prev.max_level)
          : "Departamento bloqueado";
      } else {
        el.querySelector("small").textContent =
          effText(n, n.bonus) + " por nível" + (lvl > 0 ? " · total: " + effText(n, lvl * n.bonus) : "");
      }
      el.querySelector(".cost").textContent = maxed ? "MAX" : !reached ? "Bloqueado" : cost + " pts";
      el.disabled = maxed || !reached || points < cost;
    });
  });
}

function buyNode(d, i) {
  const n = d.nodes[i];
  if (!deptUnlocked(d) || !nodeOpen(d, i) || deptLvl(n) >= n.max_level) return;
  if (deptPoints() < nodeCost(n)) return;
  S.dept[n.id] = deptLvl(n) + 1;
  recalcDept();
  renderDept();
}

function openDept() {
  inDept = true;
  $("dept").hidden = false;
  S.deptOpened = true;
  renderDept();
  checkAngela();
}
function closeDept() { inDept = false; $("dept").hidden = true; render(); }

function angelaCond(l) {
  switch (l.when) {
    case "start": return true;
    case "clear": return S.cleared >= (l.stage || 0);
    case "raid_win": return (S.raidWins || 0) >= (l.count || 1);
    case "drop": return Object.values(S.equip).some(Boolean);
    case "dept": return !!S.deptOpened;
    default: return false;
  }
}

function checkAngela() {
  const A = C.angela;
  if (!A || !inGame) return;
  (A.lines || []).forEach((l) => {
    if (S.seen[l.id] || !angelaCond(l)) return;
    S.seen[l.id] = true;
    (Array.isArray(l.text) ? l.text : [l.text]).forEach((t) =>
      angelaQueue.push(t.replace(/\{jogador\}/g, () => player))
    );
  });
  if (!angelaShowing && angelaQueue.length) showNextAngela();
}

function setAngelaText(shown, full) {
  $("angela-typed").textContent = full.slice(0, shown);
  $("angela-rest").textContent = full.slice(shown);
}

function showNextAngela() {
  clearInterval(angelaType);
  clearTimeout(angelaTimer);
  const text = angelaQueue.shift();
  if (text === undefined) {
    angelaShowing = false;
    $("angela").hidden = true;
    return;
  }
  angelaShowing = true;
  const box = $("angela");
  box.hidden = false;
  box.dataset.full = text;
  let i = 0;
  setAngelaText(0, text);
  angelaType = setInterval(() => {
    i++;
    setAngelaText(i, text);
    if (i >= text.length) clearInterval(angelaType);
  }, 25);
  angelaTimer = setTimeout(showNextAngela, 3500 + text.length * 60);
}

function angelaClick() {
  const full = $("angela").dataset.full || "";
  if ($("angela-typed").textContent.length < full.length) {
    clearInterval(angelaType);
    setAngelaText(full.length, full);
  } else {
    showNextAngela();
  }
}

function render() {
  const og = pendingOrdeal();
  const m = og ? { name: og.name, risk: "Ordeal · " + og.color, image: og.image } : monsterFor(S.stage);
  const img = $("sprite");
  if (m.image !== shownImage) {
    shownImage = m.image;
    imageFailed = false;
    if (m.image) img.src = "/static/img/" + m.image;
  }
  img.hidden = !m.image || imageFailed;
  $("enk").textContent = fmt(S.enk);
  $("player").textContent = player;
  $("dps").textContent = fmt(dps());
  renderNav();
  renderEquip();
  renderSkills();
  const dp = deptPoints();
  $("dept-open").textContent = "Departamentos" + (dp > 0 ? " (" + fmtCoin(dp) + ")" : "");
  $("stage").textContent = S.stage + (og ? " · Ordeal" : isBoss(S.stage) ? " · " + Math.ceil(bossTimer) + "s restantes" : "");
  $("name").textContent = m.name;
  $("risk").textContent = og ? m.risk : m.risk + (isBoss(S.stage) ? " (chefe)" : "");
  $("monster").classList.toggle("boss", isBoss(S.stage) && !og);
  $("monster").style.borderColor = og ? (og.hex || "") : "";
  $("hp-fill").style.width = og ? "100%" : Math.max(0, (S.hp / S.maxHp) * 100) + "%";
  $("hp-text").textContent = og ? "Clique para enfrentar o Ordeal" : fmt(Math.max(0, S.hp)) + " / " + fmt(S.maxHp) + " HP";
  $("hint").textContent = og ? "O Ordeal bloqueia o caminho. Derrote-o para avançar." : "Clique na Abnormalidade para suprimi-la.";

  setRow(
    "click",
    "Treino de Supressão",
    "Nível " + S.clickLvl + " · " + fmt(clickDamage()) + " dano/clique · " + fmtPct(share("click")) + " do dano",
    rowPlan("click"),
    clickMult() > 1 ? fmtMult(clickMult()) + "x - Bônus" : ""
  );
  C.agents.forEach((a) => {
    const mult = agentMult(a);
    const dmg = agentDmg(a);
    setRow(
      a.id,
      a.name,
      "Nível " + agentLvl(a) + " · " + fmt(dmg) + " dano/s · " + fmtPct(share(a.id)) + " do dano",
      rowPlan(a.id),
      mult > 1 ? fmtMult(mult) + "x - Bônus" : ""
    );
  });
  $("raid").hidden = !inRaid;
  if (inRaid) renderRaid();
  syncMusic();
}

/* ---------- save / load ---------- */

function save(keepalive) {
  return fetch("/api/save/" + encodeURIComponent(player), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ state: S }),
    keepalive: !!keepalive,
  }).catch(() => {});
}

async function init() {
  const packs = await (await fetch("/api/content")).json();
  C = packs.lobotomy;
  (C.raidbosses || []).forEach((b, i) => { b.drops = dropsOf(b, i); });
  dropList = allDrops();

  player = localStorage.getItem("idle_player");
  while (!player || !/^[\w-]{1,20}$/.test(player)) {
    player = (prompt("Seu nome de jogador (letras, números, - e _):") || "").trim();
  }
  localStorage.setItem("idle_player", player);

  const res = await (await fetch("/api/load/" + encodeURIComponent(player))).json();
  S = Object.assign(newState(), res.state || {});
  S.maxStage = Math.max(S.maxStage || 1, S.stage);
  S.cleared = Math.max(S.cleared || 0, (S.maxStage || 1) - 1);
  recalcDept();
  if (res.state && !res.state.ordeals) {
    (C.ordeals || []).forEach((o) => { if (o.stage <= S.cleared) S.ordeals[o.id] = true; });
  }
  if (res.state && !res.state.seen) {
    // jogador antigo: não despeja todas as falas de uma vez
    ((C.angela && C.angela.lines) || []).forEach((l) => { if (angelaCond(l)) S.seen[l.id] = true; });
  }
  if (!res.state || !S.maxHp) spawn();
      bossTimer = isBoss(S.stage) ? C.stage.boss_time + dB("boss_time") : 0;

  const rate = dps();
  if (res.state && rate > 0 && res.offline_seconds > 60) {
    const gain = rate * res.offline_seconds * C.stage.reward_ratio * Math.min(1, OFFLINE_EFFICIENCY + dB("offline"));
    S.enk += gain;
    $("msg").textContent = "Enquanto você esteve fora, seus agentes coletaram " + fmt(gain) + " caixas de enkephalin.";
  }

  buildShop();
  document.querySelectorAll("#buy-mode .chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      buyMode = btn.dataset.mode === "max" ? "max" : Number(btn.dataset.mode);
      document.querySelectorAll("#buy-mode .chip").forEach((b) => b.classList.toggle("current", b === btn));
      render();
    });
  });
  buildEquip();
  buildSkills();
  buildDept();
  $("dept-open").addEventListener("click", openDept);
  $("dept-close").addEventListener("click", closeDept);
  $("dept-respec").addEventListener("click", () => { S.dept = {}; recalcDept(); renderDept(); });
  const A = C.angela || {};
  $("angela").addEventListener("click", angelaClick);
  $("angela-name").textContent = A.name || "Angela";
  const aImg = $("angela-img");
  if (A.image) {
    aImg.src = "/static/img/" + A.image;
    aImg.hidden = false;
  }
  aImg.addEventListener("error", () => { aImg.hidden = true; });
  $("cheat-angela").addEventListener("click", () => {
    S.seen = {};
    angelaQueue = [];
    $("cheats-dialog").close();
    checkAngela();
  });
  $("cheat-ordeals").addEventListener("click", () => {
    S.ordeals = {};
    S.dept = {};
    recalcDept();
    Object.keys(S.seen).filter((k) => k.startsWith("warn-")).forEach((k) => delete S.seen[k]);
    $("cheats-dialog").close();
    render();
  });
  $("monster").addEventListener("click", () => {
    const og = pendingOrdeal();
    if (og) { startOrdeal(og); return; }
    const d = clickDamage();
    record("click", d);
    damage(d);
    render();
  });

  $("auto").checked = S.auto;
  $("auto").addEventListener("change", (e) => {
    S.auto = e.target.checked;
    render();
  });

  $("sprite").addEventListener("error", () => { imageFailed = true; render(); });

  $("reset-open").addEventListener("click", () => $("reset-dialog").showModal());
  $("reset-cancel").addEventListener("click", () => $("reset-dialog").close());
  $("reset-confirm").addEventListener("click", async () => {
    $("reset-dialog").close();
    S = newState();
    recalcDept();
    spawn();
    $("auto").checked = S.auto;
    await save(false);
    $("msg").textContent = "Progresso apagado. Você recomeçou do zero.";
    render();
  });

  $("play").disabled = false;
  $("play").textContent = "Jogar";
  $("play").addEventListener("click", () => {
    inGame = true;
    $("menu").hidden = true;
    musicStarted = true;
    updateMusicBtn();
    syncMusic(true);
  });

  buildRaidList();
  buildRaidShop();
  $("raid-open").addEventListener("click", openRaid);
  $("raid-close").addEventListener("click", closeRaid);
  $("raid-retry").addEventListener("click", () => {
    if (raid.kind === "ordeal") startOrdeal(raid.ordeal);
    else startRaid(raid.boss, true);
  });
  $("raid-back").addEventListener("click", () => {
    if (raid && raid.kind === "ordeal") closeRaid();
    else { raid = null; render(); }
  });
  $("raid-auto").addEventListener("change", (e) => { raidAuto = e.target.checked; });
  $("raid-monster").addEventListener("click", () => { raidDamage(clickDamage()); render(); });
  $("raid-sprite").addEventListener("error", () => { $("raid-sprite").hidden = true; });

  const savedVol = localStorage.getItem("idle_music_vol");
  const vol = (savedVol === null ? 30 : Number(savedVol)) / 100;
  ["bgm", "bgm-boss", "bgm-menu", "bgm-raid"].forEach((id) => { $(id).volume = vol; });
  $("music-volume").value = Math.round(vol * 100);
  musicOn = localStorage.getItem("idle_music") !== "off";

  const updateMusicBtn = () => {
    $("music-toggle").textContent = "Música: " + (musicOn && musicStarted ? "ligada" : "desligada");
  };
  updateMusicBtn();

  $("music-toggle").addEventListener("click", () => {
    if (musicOn && musicStarted) {
      musicOn = false;
      localStorage.setItem("idle_music", "off");
    } else {
      musicOn = true;
      musicStarted = true;
      localStorage.setItem("idle_music", "on");
    }
    updateMusicBtn();
    syncMusic(true);
  });

  $("music-volume").addEventListener("input", (e) => {
    const v = e.target.value / 100;
    ["bgm", "bgm-boss", "bgm-menu", "bgm-raid"].forEach((id) => { $(id).volume = v; });
    localStorage.setItem("idle_music_vol", e.target.value);
  });

  // menu: tenta tocar sozinho; se o navegador bloquear, toca na primeira interação
  const unlock = () => {
    if (musicStarted) return;
    musicStarted = true;
    updateMusicBtn();
    syncMusic(true);
  };
  if (musicOn) {
    $("bgm-menu").play().then(unlock).catch(() => {
      document.addEventListener("click", unlock, { once: true });
      document.addEventListener("keydown", unlock, { once: true });
    });
  }

  setInterval(() => {
    if (!inGame || inDept) return;
    checkAngela();
    const gate = inRaid ? null : pendingOrdeal();
    if (gate && !S.seen["warn-" + gate.id]) {
      S.seen["warn-" + gate.id] = true;
      if (gate.say) angelaSay(gate.say.warn);
    }
    if (!gate) autoSkills();
    if (inRaid) {
      tickRaid(TICK_MS / 1000);
    } else if (!gate) {
      decayRecent(TICK_MS / 1000);
      agentTick(TICK_MS / 1000);
      tickBoss(TICK_MS / 1000);
    }
    render();
  }, TICK_MS);
  
  setInterval(() => save(false), AUTOSAVE_MS);
  window.addEventListener("beforeunload", () => save(true));
    $("cheats-open").addEventListener("click", () => {
    $("cheat-msg").textContent = "";
    $("cheats-dialog").showModal();
  });
  $("cheats-close").addEventListener("click", () => $("cheats-dialog").close());
  $("cheat-money-give").addEventListener("click", () => {
    const v = Number(String($("cheat-money").value).trim().replace(",", "."));
    if (!isFinite(v) || v <= 0) {
      $("cheat-msg").textContent = "Digite um número maior que zero (ex.: 5000 ou 1e9).";
      return;
    }
    S.enk += v;
    $("cheat-msg").textContent = "+" + fmt(v) + " caixas de enkephalin adicionadas.";
    render();
  });
  render();
}

init();
