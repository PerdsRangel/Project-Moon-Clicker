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
const RAID_RESTART_DELAY = 3; // segundos de espera antes de reiniciar

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
    return { version: 1, stage: 1, maxStage: 1, cleared: 0, equip: {}, raidEnk: 0, raidUp: {}, enk: 0, clickLvl: 0, agents: {}, hp: 0, maxHp: 0, auto: true };
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
const dmgMult = () => 1 + raidUpBonus() + dropList.reduce((sum, d) => sum + (S.equip[d.id] ? d.bonus : 0), 0);
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
  return (C.raidbosses || []).flatMap((b, i) =>
    b.drops.map((d) => Object.assign({ from: b.name, unlock: (i + 1) * every }, d))
  );
}

function rollDrops(boss) {
  const got = [];
  boss.drops.forEach((d) => {
    if (!S.equip[d.id] && Math.random() < d.chance) {
      S.equip[d.id] = true;
      got.push(d);
    }
  });
  return got;
}

function spawn() {
  S.maxHp = stageHp(S.stage);
  S.hp = S.maxHp;
  bossTimer = isBoss(S.stage) ? C.stage.boss_time : 0;
}

function damage(amount) {
  S.hp -= amount;
  if (S.hp <= 0) {
    const last = C.stage.max_stage || Infinity;
    const finished = S.stage > S.cleared && S.stage === last;
    S.enk += S.maxHp * C.stage.reward_ratio;
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
  const rows = [{ id: "click", label: "Treinamento de supressão" }].concat(
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
  return plan(a.base_cost, C.agent_cost_growth, agentLvl(a));
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

function startRaid(boss) {
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
  enemies.forEach((e) => { if (e.background) new Image().src = "/static/img/" + encodeURIComponent(e.background); });
  raid = { boss, enemies, index: 0, maxHp: 0, hp: 0, time: boss.time || C.raid_time || 60, result: null, drops: [], coins: 0, restartIn: null };
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
  raid.coins = raid.boss.raid_coins || 5;
  S.raidEnk += raid.coins;
  raid.drops = rollDrops(raid.boss);
  save(false); // grava moedas e drops na hora
}

function tickRaid(dt) {
  if (!raid) { renderRaidShop(); return; }
  if (raid.result) {
    // raid terminou: se a opção estiver ligada, conta o tempo e reinicia
    if (raidAuto) {
      if (raid.restartIn === null) raid.restartIn = RAID_RESTART_DELAY;
      raid.restartIn -= dt;
      if (raid.restartIn <= 0) startRaid(raid.boss);
    }
    return;
  }
  raidDamage(dps() * dt);
  raid.time -= dt;
  if (raid.result === null && raid.time <= 0) { raid.time = 0; raid.result = "lose"; }
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

function renderRaid() {
  setRaidBackground(raid ? raid.enemies[raid.index].background : null);
  $("raid-select").hidden = !!raid;
  $("raid-fight").hidden = !raid;
  if (!raid) return;
  const e = raid.enemies[raid.index];
  $("raid-name").textContent = e.name;
  $("raid-risk").textContent = e.risk + (e.isBoss ? " (Boss Raid)" : "");
  $("raid-monster").classList.toggle("boss", e.isBoss);
  $("raid-progress").textContent = raid.enemies.length > 1
    ? "· Inimigo " + (raid.index + 1) + " de " + raid.enemies.length
    : "";
  $("raid-time").textContent = Math.ceil(raid.time);
  $("raid-hp-fill").style.width = Math.max(0, (raid.hp / raid.maxHp) * 100) + "%";
  $("raid-hp-text").textContent = fmt(Math.max(0, raid.hp)) + " / " + fmt(raid.maxHp) + " HP";
  const res = $("raid-result");
  const dropText = raid.drops.length
    ? " Drop: " + raid.drops.map((d) => d.name).join(", ") + "!"
    : " Nenhum drop desta vez.";
    res.textContent = raid.result === "win"
    ? "Chefe derrotado! +" + fmtCoin(raid.coins) + " Caixas de Enkephalin Raid. " + dropText
    : raid.result === "lose" ? "O tempo acabou. O chefe escapou." : "";
  if (raid.result && raidAuto && raid.restartIn !== null) {
    res.textContent += " Reiniciando em " + Math.ceil(Math.max(0, raid.restartIn)) + "s...";
  }
  res.className = "raid-result" + (raid.result ? " " + raid.result : "");
  $("raid-retry").hidden = !raid.result;
  $("raid-monster").disabled = !!raid.result;
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

function render() {
  const m = monsterFor(S.stage);
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
  $("stage").textContent = S.stage + (isBoss(S.stage) ? " · " + Math.ceil(bossTimer) + "s restantes" : "");
  $("name").textContent = m.name;
  $("risk").textContent = m.risk + (isBoss(S.stage) ? " (chefe)" : "");
  $("monster").classList.toggle("boss", isBoss(S.stage));
  $("hp-fill").style.width = Math.max(0, (S.hp / S.maxHp) * 100) + "%";
  $("hp-text").textContent = fmt(Math.max(0, S.hp)) + " / " + fmt(S.maxHp) + " HP";

  setRow(
    "click",
    "Treinamento de supressão",
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
  if (!res.state || !S.maxHp) spawn();
      bossTimer = isBoss(S.stage) ? C.stage.boss_time : 0;

  const rate = dps();
  if (res.state && rate > 0 && res.offline_seconds > 60) {
    const gain = rate * res.offline_seconds * C.stage.reward_ratio * OFFLINE_EFFICIENCY;
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
  $("monster").addEventListener("click", () => {
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
  $("raid-back").addEventListener("click", () => { raid = null; render(); });
  $("raid-retry").addEventListener("click", () => startRaid(raid.boss));
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
    if (!inGame) return;
    if (inRaid) {
      tickRaid(TICK_MS / 1000);
    } else {
      decayRecent(TICK_MS / 1000);
      agentTick(TICK_MS / 1000);
      tickBoss(TICK_MS / 1000);
    }
    render();
  }, TICK_MS);
  setInterval(() => save(false), AUTOSAVE_MS);
  window.addEventListener("beforeunload", () => save(true));
  render();
}

init();
