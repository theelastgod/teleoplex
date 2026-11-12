const VENUES = [
  { id: "pump", chain: "solana", name: "Pump.fun", line: "Create the coin and buy it with your wallets in one bundle.", cap: 5 },
  { id: "solana", chain: "solana", name: "Solana", line: "Mint a fixed Token-2022 supply into your wallets.", cap: 5 },
  { id: "robinhood", chain: "evm", name: "Robinhood", line: "Pons launch-and-buy on Robinhood Chain.", cap: 8 },
  { id: "hyperliquid", chain: "evm", name: "Hyperliquid", line: "HIP-1 spot deploy, one signed step at a time.", cap: 12 },
];

const STEPS = ["Venue", "Coin", "Wallets", "Review"];

const draft = {
  venue: "pump",
  network: "devnet",
  step: 0,
  coin: { name: "", symbol: "", description: "", twitter: "", telegram: "", website: "" },
  image: null,
  legs: [],
  taxBps: "0",
  confirm: "",
  hl: {
    step: "registerToken2",
    szDecimals: "2",
    weiDecimals: "8",
    maxGas: "",
    token: "",
    maxSupply: "",
    noHyperliquidity: false,
    spot: "",
    startPx: "",
    orderSz: "",
    nOrders: "",
  },
};

let session = sessionStorage.getItem("keel.session") || "";
let desk = { locked: true, hasVault: false, settings: {}, wallets: [], launches: [] };
let view = "launch";
let quote = null;
let balances = {};
let notice = "";
let noticeOk = false;

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "for") node.htmlFor = value;
    else if (key === "hidden") node.hidden = Boolean(value);
    else if (key === "checked") node.checked = Boolean(value);
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of [].concat(children)) {
    if (child == null || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

function venue() {
  return VENUES.find((item) => item.id === draft.venue);
}

function needsConfirm() {
  return draft.venue === "robinhood" || draft.network === "mainnet";
}

function chainWallets() {
  return desk.wallets.filter((row) => row.chain === venue().chain);
}

function short(address) {
  if (!address || address.length < 12) return address || "";
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

function formatRaw(raw, decimals) {
  try {
    const value = BigInt(raw || 0);
    const scale = 10n ** BigInt(decimals);
    const whole = value / scale;
    let frac = (value % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
    if (frac.length > 6) frac = frac.slice(0, 6);
    return frac ? `${whole.toLocaleString("en-US")}.${frac}` : whole.toLocaleString("en-US");
  } catch {
    return String(raw || "0");
  }
}

function tokenDecimals() {
  if (draft.venue === "robinhood") return 18;
  return 6;
}

async function api(path, { method = "GET", body, auth = true } = {}) {
  const headers = {};
  if (auth && session) headers["x-keel-session"] = session;
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) {
    session = "";
    sessionStorage.removeItem("keel.session");
    desk.locked = true;
    render();
  }
  if (!response.ok) throw new Error(data.error || "Request failed.");
  return data;
}

function say(message, ok = false) {
  notice = message || "";
  noticeOk = ok;
  const slot = document.querySelector("[data-notice]");
  if (!slot) return;
  slot.textContent = notice;
  slot.className = ok ? "ok" : "error";
}

function launchBody(spend) {
  const symbol = draft.venue === "hyperliquid" ? draft.coin.symbol.toUpperCase() : draft.coin.symbol.trim();
  return {
    venue: draft.venue,
    network: draft.network,
    spend,
    confirm: draft.confirm.trim(),
    creatorTaxBps: Number(draft.taxBps || 0),
    coin: {
      ...draft.coin,
      symbol,
      imageBase64: draft.image?.base64 || "",
      imageType: draft.image?.type || "",
    },
    legs: draft.legs.filter((leg) => leg.walletId).map((leg) => ({
      walletId: leg.walletId,
      amount: leg.amount || "0",
      unit: leg.unit,
      tokens: leg.unit === "tokens" ? leg.amount || "0" : undefined,
    })),
    step: draft.hl.step,
    szDecimals: Number(draft.hl.szDecimals),
    weiDecimals: Number(draft.hl.weiDecimals),
    maxGas: draft.hl.maxGas === "" ? undefined : Number(draft.hl.maxGas),
    token: draft.hl.token === "" ? undefined : Number(draft.hl.token),
    maxSupply: draft.hl.maxSupply || undefined,
    noHyperliquidity: draft.hl.noHyperliquidity,
    spot: draft.hl.spot === "" ? undefined : Number(draft.hl.spot),
    startPx: draft.hl.startPx || undefined,
    orderSz: draft.hl.orderSz || undefined,
    nOrders: draft.hl.nOrders === "" ? undefined : Number(draft.hl.nOrders),
    launcher: draft.legs[0] ? desk.wallets.find((row) => row.id === draft.legs[0].walletId)?.address : undefined,
  };
}

function render() {
  const app = document.querySelector("#app");
  app.replaceChildren(desk.locked || !session ? lockView() : shell());
}

function solanaWallets() {
  const found = [];
  const phantom = window.phantom?.solana;
  if (phantom?.isPhantom) found.push({ name: "Phantom", chain: "Solana", provider: phantom });
  if (window.solflare?.isSolflare) found.push({ name: "Solflare", chain: "Solana", provider: window.solflare });
  const backpack = window.backpack;
  if (backpack?.isBackpack) found.push({ name: "Backpack", chain: "Solana", provider: backpack });
  if (window.solana?.isPhantom && !found.some((row) => row.name === "Phantom")) {
    found.push({ name: "Phantom", chain: "Solana", provider: window.solana });
  }
  return found;
}

function evmProviders() {
  return new Promise((resolve) => {
    const found = new Map();
    const onAnnounce = (event) => found.set(event.detail.info.uuid, event.detail);
    window.addEventListener("eip6963:announceProvider", onAnnounce);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    setTimeout(() => {
      window.removeEventListener("eip6963:announceProvider", onAnnounce);
      const rows = [...found.values()].map((detail) => ({
        name: detail.info.name,
        chain: "EVM",
        provider: detail.provider,
      }));
      if (!rows.length && window.ethereum) rows.push({ name: "Browser wallet", chain: "EVM", provider: window.ethereum });
      resolve(rows);
    }, 80);
  });
}

function bytesToBase64(bytes) {
  const list = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const byte of list) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function finishSignIn(opened) {
  session = opened.token;
  sessionStorage.setItem("keel.session", session);
  await refresh();
}

async function connectSolana(row) {
  say("");
  const response = await row.provider.connect();
  const address = response?.publicKey?.toString() || row.provider.publicKey.toString();
  const challenge = await api("/api/auth/challenge", {
    method: "POST",
    auth: false,
    body: { address, chain: "solana" },
  });
  const signed = await row.provider.signMessage(new TextEncoder().encode(challenge.message), "utf8");
  const signature = signed?.signature || signed;
  const opened = await api("/api/auth/wallet", {
    method: "POST",
    auth: false,
    body: { address, chain: "solana", nonce: challenge.nonce, signature: bytesToBase64(signature) },
  });
  await finishSignIn(opened);
}

async function connectEvm(row) {
  say("");
  const accounts = await row.provider.request({ method: "eth_requestAccounts" });
  const address = accounts[0];
  const challenge = await api("/api/auth/challenge", {
    method: "POST",
    auth: false,
    body: { address, chain: "evm" },
  });
  const signature = await row.provider.request({
    method: "personal_sign",
    params: [challenge.message, address],
  });
  const opened = await api("/api/auth/wallet", {
    method: "POST",
    auth: false,
    body: { address, chain: "evm", nonce: challenge.nonce, signature },
  });
  await finishSignIn(opened);
}

function lockView() {
  const list = el("div", { class: "wallet-list" });
  for (const row of solanaWallets()) {
    const button = el("button", { type: "button" }, [row.name, el("span", {}, row.chain)]);
    button.addEventListener("click", () => connectSolana(row).catch((error) => say(error.message)));
    list.append(button);
  }
  const evmSlot = el("div", { class: "wallet-list" });
  list.append(evmSlot);
  evmProviders().then((rows) => {
    if (!list.isConnected) return;
    for (const row of rows) {
      const button = el("button", { type: "button" }, [row.name, el("span", {}, row.chain)]);
      button.addEventListener("click", () => connectEvm(row).catch((error) => say(error.message)));
      evmSlot.append(button);
    }
    if (!solanaWallets().length && !rows.length) {
      evmSlot.append(el("p", { class: "hint" }, "Install Phantom, Solflare, Backpack, or an Ethereum wallet in this browser."));
    }
  });
  const passphrase = el("input", { type: "password", autocomplete: "current-password", placeholder: "At least 8 characters" });
  const machine = el("div", { class: "stack", hidden: true }, [
    el("label", { class: "field" }, [el("span", { class: "kicker" }, "Machine passphrase"), passphrase]),
  ]);
  const unlock = el("button", { class: "btn", type: "button" }, desk.hasVault ? "Unlock" : "Create vault");
  unlock.addEventListener("click", async () => {
    say("");
    try {
      const opened = await api("/api/vault", {
        method: "POST",
        auth: false,
        body: { passphrase: passphrase.value, create: !desk.hasVault },
      });
      await finishSignIn(opened);
    } catch (error) {
      say(error.message);
    }
  });
  machine.append(unlock);
  const toggle = el("button", { class: "pass-toggle", type: "button" }, ["Machine passphrase", el("span", {}, "LOCAL")]);
  toggle.addEventListener("click", () => { machine.hidden = !machine.hidden; });
  return el("main", { class: "gate" }, el("section", { class: "gate-card" }, [
    wordmark("gate-logo"),
    el("p", { class: "ticker" }, "$TLPX"),
    el("p", { class: "lede" }, "Sign in with the wallet that pays. The pad generates the bundle. Mainnet takes 0.5% of the SOL and buys and burns $TLPX."),
    el("div", { class: "stack" }, [
      list,
      toggle,
      machine,
      el("p", { class: "error", "data-notice": "1" }, notice),
    ]),
  ]));
}

function shell() {
  const labels = { launch: "Pad", wallets: "Wallets", book: "Book", settings: "Settings" };
  const nav = el("nav", { class: "nav" }, ["launch", "wallets", "book", "settings"].map((id) => {
    const button = el("button", { type: "button", "aria-current": view === id ? "page" : false }, labels[id]);
    button.addEventListener("click", () => {
      view = id;
      notice = "";
      render();
    });
    return button;
  }));
  const lock = el("button", { class: "btn small", type: "button" }, desk.account ? "Disconnect" : "Lock");
  lock.addEventListener("click", async () => {
    await api("/api/lock", { method: "POST", body: {} }).catch(() => {});
    session = "";
    sessionStorage.removeItem("keel.session");
    desk.locked = true;
    render();
  });
  const who = desk.account ? el("p", { class: "who" }, `${desk.account.chain} ${short(desk.account.address)}`) : null;
  return el("div", { class: "shell" }, [
    el("aside", { class: "rail" }, [
      wordmark("rail-logo"),
      el("p", { class: "ticker" }, "$TLPX"),
      who,
      nav,
      el("div", { class: "spacer" }),
      el("p", { class: "rail-note" }, [el("strong", {}, "0.5%"), " of a Pump bundle buys and burns ", el("strong", {}, "$TLPX"), "."]),
      lock,
    ]),
    el("main", { class: "stage" }, view === "wallets" ? walletsView() : view === "book" ? bookView() : view === "settings" ? settingsView() : launchView()),
  ]);
}

function launchView() {
  const steps = el("ol", { class: "steps" }, STEPS.map((label, index) => {
    const button = el("button", { type: "button", "aria-current": draft.step === index ? "step" : false }, label);
    button.addEventListener("click", () => {
      draft.step = index;
      if (index === 3) price().catch((error) => say(error.message));
      else render();
    });
    return el("li", {}, button);
  }));
  return el("section", {}, [
    el("header", { class: "stage-head" }, [
      el("div", {}, [el("h2", {}, "Pad"), steps]),
    ]),
    banner(),
    el("div", { class: "layout" }, [
      el("div", { class: "panel" }, [stepBody(), el("p", { class: noticeOk ? "ok" : "error", "data-notice": "1" }, notice)]),
      ticket(),
    ]),
  ]);
}

function banner() {
  const live = needsConfirm();
  const text = draft.venue === "robinhood"
    ? "Robinhood Chain is mainnet. Type the ticker to send."
    : live
      ? "Mainnet. Type the ticker to send."
      : draft.venue === "hyperliquid"
        ? "Hyperliquid testnet. The auction step is the one that spends HYPE."
        : "Practice cluster. Sends stay on devnet until you switch to mainnet.";
  return el("p", { class: live ? "banner live" : "banner" }, text);
}

function stepBody() {
  if (draft.step === 0) return venueStep();
  if (draft.step === 1) return coinStep();
  if (draft.step === 2) return walletStep();
  return reviewStep();
}

function venueStep() {
  const cards = el("div", { class: "cards" }, VENUES.map((item) => {
    const button = el("button", { class: "card", type: "button", "aria-pressed": draft.venue === item.id ? "true" : "false" }, [
      el("strong", {}, item.name),
      el("span", {}, item.line),
    ]);
    button.addEventListener("click", () => {
      draft.venue = item.id;
      draft.network = item.id === "hyperliquid" ? "testnet" : "devnet";
      draft.legs = draft.legs.filter((leg) => desk.wallets.find((row) => row.id === leg.walletId)?.chain === item.chain);
      draft.confirm = "";
      quote = null;
      render();
    });
    return button;
  }));
  const network = networkControl();
  const next = el("button", { class: "btn primary", type: "button" }, "Coin");
  next.addEventListener("click", () => { draft.step = 1; render(); });
  return el("div", { class: "panel" }, [cards, network, el("div", { class: "row" }, next)]);
}

function networkControl() {
  if (draft.venue === "robinhood") {
    return el("p", { class: "hint" }, "Pons runs on Robinhood Chain, chain id 4663. Create and the first buy are one transaction.");
  }
  const practice = draft.venue === "hyperliquid" ? "testnet" : "devnet";
  const select = el("select", {}, [
    el("option", { value: practice, selected: draft.network !== "mainnet" }, draft.venue === "hyperliquid" ? "Testnet" : "Devnet"),
    el("option", { value: "mainnet", selected: draft.network === "mainnet" }, "Mainnet"),
  ]);
  select.addEventListener("change", () => {
    draft.network = select.value;
    draft.confirm = "";
    render();
  });
  return el("label", { class: "field" }, [el("span", { class: "kicker" }, "Network"), select]);
}

function coinStep() {
  const fields = el("div", { class: "panel" }, [
    el("div", { class: "grid-2" }, [
      field("Name", "name", draft.venue === "hyperliquid" ? "Full name" : "Name"),
      field("Ticker", "symbol", "TLPX"),
    ]),
    area("Description", "description"),
    el("div", { class: "grid-2" }, [
      field("Twitter", "twitter", "https://"),
      field("Telegram", "telegram", "https://"),
    ]),
    field("Website", "website", "https://"),
  ]);
  if (draft.venue === "pump" || draft.venue === "solana") {
    const file = el("input", { type: "file", accept: "image/png,image/jpeg,image/gif,image/webp" });
    file.addEventListener("change", () => readImage(file.files[0]));
    fields.append(el("label", { class: "field" }, [
      el("span", { class: "kicker" }, draft.venue === "pump" ? "Image, required to send" : "Image, kept with the launch record"),
      file,
      draft.image ? el("span", { class: "hint" }, draft.image.name) : null,
    ]));
  }
  if (draft.venue === "robinhood") {
    const tax = el("input", { value: draft.taxBps, inputmode: "numeric" });
    tax.addEventListener("input", () => { draft.taxBps = tax.value; });
    fields.append(el("label", { class: "field" }, [el("span", { class: "kicker" }, "Creator tax, basis points"), tax]));
  }
  if (draft.venue === "hyperliquid") fields.append(hyperliquidFields());
  const back = el("button", { class: "btn", type: "button" }, "Venue");
  const next = el("button", { class: "btn primary", type: "button" }, "Wallets");
  back.addEventListener("click", () => { draft.step = 0; render(); });
  next.addEventListener("click", () => { draft.step = 2; render(); });
  fields.append(el("div", { class: "row" }, [back, next]));
  return fields;
}

function field(label, key, placeholder) {
  const input = el("input", { value: draft.coin[key], placeholder });
  input.addEventListener("input", () => {
    draft.coin[key] = key === "symbol" && draft.venue === "hyperliquid" ? input.value.toUpperCase() : input.value;
    if (key === "symbol" && draft.venue === "hyperliquid") input.value = draft.coin.symbol;
  });
  return el("label", { class: "field" }, [el("span", { class: "kicker" }, label), input]);
}

function area(label, key) {
  const input = el("textarea", {}, draft.coin[key]);
  input.addEventListener("input", () => { draft.coin[key] = input.value; });
  return el("label", { class: "field" }, [el("span", { class: "kicker" }, label), input]);
}

function readImage(file) {
  if (!file) return;
  if (file.size > 1_500_000) {
    say("Image is larger than 1.5 MB.");
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    const text = String(reader.result || "");
    const match = text.match(/^data:(image\/(?:png|jpeg|gif|webp));base64,(.+)$/);
    if (!match) {
      say("Image needs to be PNG, JPEG, GIF, or WebP.");
      return;
    }
    draft.image = { type: match[1], base64: match[2], name: file.name };
    say("");
    render();
  };
  reader.readAsDataURL(file);
}

function hyperliquidFields() {
  const step = el("select", {}, [
    ["registerToken2", "Buy the ticker"],
    ["userGenesis", "Assign supply"],
    ["genesis", "Set the supply"],
    ["registerSpot", "Open the USDC book"],
    ["registerHyperliquidity", "Seed the book"],
  ].map(([value, label]) => el("option", { value, selected: draft.hl.step === value }, label)));
  step.addEventListener("change", () => { draft.hl.step = step.value; render(); });
  const box = el("div", { class: "panel" }, [
    el("label", { class: "field" }, [el("span", { class: "kicker" }, "Step"), step]),
  ]);
  const bind = (key, label, placeholder) => {
    const input = el("input", { value: draft.hl[key], placeholder });
    input.addEventListener("input", () => { draft.hl[key] = input.value; });
    box.append(el("label", { class: "field" }, [el("span", { class: "kicker" }, label), input]));
  };
  if (draft.hl.step === "registerToken2") {
    bind("szDecimals", "Size decimals", "2");
    bind("weiDecimals", "Wei decimals", "8");
    bind("maxGas", "Max gas, auction units", "The most you will pay");
  } else if (draft.hl.step === "userGenesis") {
    bind("token", "Token index", "From the ticker purchase");
    box.append(el("p", { class: "hint" }, "Each wallet amount below is whole wei of this token."));
  } else if (draft.hl.step === "genesis") {
    bind("token", "Token index", "");
    bind("maxSupply", "Max supply, wei", "");
    const check = el("input", { type: "checkbox", checked: draft.hl.noHyperliquidity });
    check.addEventListener("change", () => { draft.hl.noHyperliquidity = check.checked; });
    box.append(el("label", { class: "row" }, [check, "Skip hyperliquidity"]));
  } else if (draft.hl.step === "registerSpot") {
    bind("token", "Base token index", "");
  } else {
    bind("spot", "Spot index", "");
    bind("startPx", "Start price", "");
    bind("orderSz", "Order size", "");
    bind("nOrders", "Order count", "");
  }
  return box;
}

function defaultUnit() {
  if (draft.venue === "pump") return "sol";
  if (draft.venue === "solana") return "percent";
  if (draft.venue === "hyperliquid") return "wei";
  return "eth";
}

function walletStep() {
  const available = chainWallets();
  const rows = el("div", { class: "panel" }, draft.legs.map((leg, index) => legRow(leg, index, available)));
  const add = el("button", { class: "btn", type: "button" }, "Add wallet");
  add.disabled = draft.legs.length >= venue().cap || available.length === 0;
  add.addEventListener("click", () => {
    if (draft.legs.length >= venue().cap) return;
    draft.legs.push({ walletId: "", amount: "", unit: defaultUnit() });
    render();
  });
  const back = el("button", { class: "btn", type: "button" }, "Coin");
  const next = el("button", { class: "btn primary", type: "button" }, "Review");
  back.addEventListener("click", () => { draft.step = 1; render(); });
  next.addEventListener("click", () => { draft.step = 3; price().catch((error) => say(error.message)); });
  const generate = el("button", { class: "btn primary", type: "button" }, `Generate ${venue().cap}`);
  generate.addEventListener("click", () => generateBundle().catch((error) => say(error.message)));
  return el("div", { class: "panel" }, [
    el("p", { class: "hint" }, `Generate builds ${venue().cap} new wallets for this bundle. The first is the dev wallet.`),
    draft.legs.length ? rows : el("p", { class: "hint" }, "No wallets in this bundle yet."),
    el("div", { class: "row" }, [back, generate, add, next]),
  ]);
}

function defaultAmount() {
  if (draft.venue === "pump") return "0.1";
  if (draft.venue === "solana") return "2";
  if (draft.venue === "hyperliquid") return "";
  return "0.01";
}

async function generateBundle() {
  const count = venue().cap;
  const made = await api("/api/wallets", {
    method: "POST",
    body: { chain: venue().chain, label: "Bundle", count },
  });
  const unit = defaultUnit();
  const amount = defaultAmount();
  draft.legs = made.wallets.map((row) => ({ walletId: row.id, amount, unit }));
  await refresh(false);
  say(`Generated ${made.wallets.length} wallets.`, true);
  render();
}

function wordmark(className) {
  return el("div", { class: `logo ${className}`, role: "img", "aria-label": "Teleoplex" }, [
    "TELE",
    el("i", { "aria-hidden": "true" }),
    "PLEX",
  ]);
}

function legRow(leg, index, available) {
  const select = el("select", {}, [el("option", { value: "" }, "Wallet"), ...available.map((row) => (
    el("option", { value: row.id, selected: leg.walletId === row.id }, `${row.label} ${short(row.address)}`)
  ))]);
  select.addEventListener("change", () => { leg.walletId = select.value; });
  const amount = el("input", { value: leg.amount, inputmode: "decimal", placeholder: amountPlaceholder() });
  amount.addEventListener("input", () => { leg.amount = amount.value; });
  const unit = unitSelect(leg);
  const remove = el("button", { class: "btn small", type: "button" }, "Remove");
  remove.addEventListener("click", () => { draft.legs.splice(index, 1); render(); });
  return el("div", { class: "grid-3" }, [
    el("label", { class: "field" }, [el("span", { class: "kicker" }, index === 0 ? "Dev" : `Wallet ${index + 1}`), select]),
    el("label", { class: "field" }, [el("span", { class: "kicker" }, "Amount"), amount]),
    unit ? el("label", { class: "field" }, [el("span", { class: "kicker" }, "Unit"), unit]) : el("span"),
    remove,
  ]);
}

function amountPlaceholder() {
  if (draft.venue === "pump") return "0.1";
  if (draft.venue === "solana") return "2";
  if (draft.venue === "hyperliquid" && draft.hl.step === "userGenesis") return "wei";
  if (draft.venue === "hyperliquid") return "Deployer";
  return "0.01";
}

function unitSelect(leg) {
  if (draft.venue === "robinhood" || draft.venue === "hyperliquid") return null;
  const options = draft.venue === "pump"
    ? [["sol", "SOL"], ["percent", "% of supply"]]
    : [["percent", "% of supply"], ["tokens", "Raw tokens"]];
  const select = el("select", {}, options.map(([value, label]) => el("option", { value, selected: leg.unit === value }, label)));
  select.addEventListener("change", () => { leg.unit = select.value; });
  return select;
}

function reviewStep() {
  const back = el("button", { class: "btn", type: "button" }, "Wallets");
  back.addEventListener("click", () => { draft.step = 2; render(); });
  const priceButton = el("button", { class: "btn", type: "button" }, "Price again");
  priceButton.addEventListener("click", () => price().catch((error) => say(error.message)));
  const send = el("button", { class: "btn primary", type: "button" }, sendLabel());
  const confirm = el("input", { value: draft.confirm, placeholder: draft.coin.symbol || "Ticker", autocomplete: "off" });
  confirm.addEventListener("input", () => {
    draft.confirm = confirm.value;
    send.disabled = needsConfirm() && confirm.value.trim() !== (draft.venue === "hyperliquid" ? draft.coin.symbol.toUpperCase() : draft.coin.symbol.trim());
  });
  send.disabled = needsConfirm() && draft.confirm.trim() !== (draft.venue === "hyperliquid" ? draft.coin.symbol.toUpperCase() : draft.coin.symbol.trim());
  send.addEventListener("click", () => sendLaunch(send));
  const action = quote?.action ? el("pre", { class: "action" }, JSON.stringify(quote.action, null, 2)) : null;
  return el("div", { class: "panel" }, [
    el("p", { class: "hint" }, reviewNote()),
    needsConfirm() ? el("label", { class: "field" }, [el("span", { class: "kicker" }, `Type ${draft.coin.symbol || "the ticker"}`), confirm]) : null,
    action,
    el("div", { class: "row" }, [back, priceButton, send]),
  ]);
}

function sendLabel() {
  if (draft.venue === "hyperliquid") return "Sign this step";
  if (draft.venue === "robinhood") return "Send on Robinhood Chain";
  if (draft.network === "mainnet") return "Send on mainnet";
  return "Send on devnet";
}

function reviewNote() {
  if (quote?.note) return quote.note;
  if (draft.venue === "pump") return "Create, the dev buy, and the other buys are one bundle on mainnet.";
  if (draft.venue === "solana") return "The dev wallet keeps the supply the other wallets do not receive.";
  if (draft.venue === "robinhood") return "Create and the first buy are one transaction. The other wallets buy immediately after.";
  return "One Hyperliquid step is signed. The ticker purchase spends HYPE.";
}

function ticket() {
  const rows = [];
  if (quote?.costSol) rows.push(["Spend", `${quote.costSol} SOL`]);
  if (quote?.feeSol) rows.push(["$TLPX", `${quote.feeSol} SOL · 0.5% buy and burn`]);
  if (quote?.percent != null) rows.push(["Curve", `${quote.percent}%`]);
  if (quote?.terms?.launchFeeEth) rows.push(["Launch fee", `${quote.terms.launchFeeEth} ETH`]);
  if (quote?.terms && quote.terms.canLaunch != null) rows.push(["Can launch", quote.terms.canLaunch ? "Yes" : "No"]);
  (quote?.rows || []).forEach((row, index) => {
    const wallet = desk.wallets.find((item) => item.id === row.id);
    const name = wallet ? wallet.label : `Wallet ${index + 1}`;
    const bought = row.tokens && row.tokens !== "0" ? formatRaw(row.tokens, tokenDecimals()) : "";
    const paid = draft.venue === "pump" || draft.venue === "solana"
      ? formatRaw(row.lamports, 9)
      : draft.venue === "robinhood"
        ? formatRaw(row.lamports, 18)
        : "";
    rows.push([name, [paid && `${paid}`, bought && `${bought} tokens`, row.percent ? `${row.percent}%` : ""].filter(Boolean).join(" · ") || "0"]);
  });
  (quote?.transactions || []).forEach((tx, index) => {
    rows.push([`Tx ${index + 1}`, tx.tip ? `${tx.kind}, tip` : tx.kind]);
  });
  if (quote?.unavailable) rows.push(["Quote", quote.note || "Unavailable"]);
  if (quote?.auctionError) rows.push(["Auction", quote.auctionError]);
  if (quote?.error) rows.push(["Step", quote.error]);
  return el("aside", { class: "ticket" }, [
    el("span", { class: "kicker" }, "Ticket"),
    el("h3", {}, venue().name),
    el("dl", {}, rows.flatMap(([term, detail]) => [el("dt", {}, term), el("dd", {}, detail || "—")])),
  ]);
}

async function price() {
  say("");
  const body = launchBody(false);
  if (!body.legs.length) {
    quote = null;
    render();
    say("Pick at least one wallet.");
    return;
  }
  quote = await api("/api/quote", { method: "POST", body, auth: false });
  if (draft.venue === "hyperliquid" || draft.venue === "robinhood") {
    const preview = await api("/api/launch", { method: "POST", body });
    quote = { ...quote, ...preview, note: quote.note };
  }
  render();
}

async function sendLaunch(button) {
  button.disabled = true;
  say("");
  try {
    const result = await api("/api/launch", { method: "POST", body: launchBody(true) });
    if (result.sent) {
      say(`Sent. ${result.mint || result.symbol || "Recorded in the book."}`, true);
      await refresh(false);
      view = "book";
      render();
      say(`Sent. ${result.mint || ""}`, true);
    } else {
      say(result.error || "The launch stayed a preview.");
      button.disabled = false;
    }
  } catch (error) {
    say(error.message);
    button.disabled = false;
  }
}

function walletsView() {
  const table = el("table", {}, [
    el("thead", {}, el("tr", {}, ["Label", "Chain", "Address", "Balance", ""].map((label) => el("th", {}, label)))),
    el("tbody", {}, desk.wallets.map((row) => el("tr", {}, [
      el("td", {}, row.label),
      el("td", {}, row.chain),
      el("td", { class: "mono" }, row.address),
      el("td", { class: "mono" }, balances[row.id]?.balance != null ? `${balances[row.id].balance} ${balances[row.id].unit}` : "—"),
      el("td", {}, walletActions(row)),
    ]))),
  ]);
  const refreshButton = el("button", { class: "btn small", type: "button" }, "Balances");
  refreshButton.addEventListener("click", () => loadBalances().catch((error) => say(error.message)));
  return el("section", {}, [
    el("header", { class: "stage-head" }, [el("h2", {}, "Wallets"), refreshButton]),
    el("p", { class: noticeOk ? "ok" : "error", "data-notice": "1" }, notice),
    desk.wallets.length ? table : el("p", { class: "hint" }, "No wallets yet."),
    el("div", { class: "split" }, [createWalletForm(), importWalletForm()]),
    fundForm(),
  ]);
}

function walletActions(row) {
  const wrap = el("div", { class: "row" });
  if (row.chain === "solana" && desk.settings.solanaCluster !== "mainnet") {
    const drop = el("button", { class: "btn small", type: "button" }, "Airdrop 1");
    drop.addEventListener("click", async () => {
      try {
        const result = await api("/api/airdrop", { method: "POST", body: { walletId: row.id, amount: "1", network: "devnet" } });
        say(`Airdrop sent ${short(result.signature)}.`, true);
      } catch (error) {
        say(error.message);
      }
    });
    wrap.append(drop);
  }
  const remove = el("button", { class: "btn small danger", type: "button" }, "Delete");
  remove.addEventListener("click", async () => {
    if (!window.confirm(`Delete ${row.label}? The address leaves this book.`)) return;
    await api(`/api/wallets/${encodeURIComponent(row.id)}`, { method: "DELETE" });
    await refresh();
  });
  wrap.append(remove);
  return wrap;
}

function createWalletForm() {
  const chain = el("select", {}, [el("option", { value: "solana" }, "Solana"), el("option", { value: "evm" }, "Ethereum")]);
  const label = el("input", { placeholder: "Desk" });
  const count = el("input", { value: "1", inputmode: "numeric" });
  const button = el("button", { class: "btn primary", type: "button" }, "Generate");
  button.addEventListener("click", async () => {
    try {
      await api("/api/wallets", { method: "POST", body: { chain: chain.value, label: label.value, count: Number(count.value || 1) } });
      say("Wallet saved in the vault.", true);
      await refresh();
    } catch (error) {
      say(error.message);
    }
  });
  return el("div", { class: "block" }, [
    el("h3", {}, "Generate"),
    el("label", { class: "field" }, [el("span", { class: "kicker" }, "Chain"), chain]),
    el("label", { class: "field" }, [el("span", { class: "kicker" }, "Label"), label]),
    el("label", { class: "field" }, [el("span", { class: "kicker" }, "Count"), count]),
    button,
  ]);
}

function importWalletForm() {
  const chain = el("select", {}, [el("option", { value: "solana" }, "Solana"), el("option", { value: "evm" }, "Ethereum")]);
  const label = el("input", { placeholder: "Imported" });
  const secret = el("input", { type: "password", autocomplete: "off" });
  const button = el("button", { class: "btn", type: "button" }, "Import");
  button.addEventListener("click", async () => {
    try {
      await api("/api/wallets/import", { method: "POST", body: { chain: chain.value, label: label.value, secret: secret.value } });
      secret.value = "";
      say("Imported into the vault.", true);
      await refresh();
    } catch (error) {
      say(error.message);
    }
  });
  return el("div", { class: "block" }, [
    el("h3", {}, "Import"),
    el("label", { class: "field" }, [el("span", { class: "kicker" }, "Chain"), chain]),
    el("label", { class: "field" }, [el("span", { class: "kicker" }, "Label"), label]),
    el("label", { class: "field" }, [el("span", { class: "kicker" }, "Secret"), secret]),
    button,
  ]);
}

function fundForm() {
  const funder = el("select", {}, desk.wallets.map((row) => el("option", { value: row.id }, `${row.label} · ${row.chain}`)));
  const lines = el("div", { class: "panel" });
  const entries = [];
  function addLine() {
    const target = el("select", {}, desk.wallets.map((row) => el("option", { value: row.id }, row.label)));
    const amount = el("input", { placeholder: "0.1", inputmode: "decimal" });
    const row = { target, amount };
    entries.push(row);
    lines.append(el("div", { class: "grid-2" }, [target, amount]));
  }
  addLine();
  const more = el("button", { class: "btn small", type: "button" }, "Another");
  more.addEventListener("click", addLine);
  const typed = el("input", { placeholder: "FUND", autocomplete: "off" });
  const send = el("button", { class: "btn primary", type: "button" }, "Transfer");
  send.addEventListener("click", async () => {
    try {
      if (typed.value.trim() !== "FUND") throw new Error("Type FUND to send this transfer.");
      const result = await api("/api/fund", {
        method: "POST",
        body: {
          funderId: funder.value,
          confirm: "FUND",
          spend: true,
          network: desk.settings.solanaCluster,
          entries: entries.map((row) => ({ walletId: row.target.value, amount: row.amount.value })).filter((row) => row.amount),
        },
      });
      say(`Transfer sent. ${(result.signatures || result.hashes || []).length} transaction(s).`, true);
    } catch (error) {
      say(error.message);
    }
  });
  return el("section", { class: "block" }, [
    el("h3", {}, "Fund"),
    el("p", { class: "hint" }, "A direct transfer from one of your wallets to the others. Twelve Solana transfers fit in one transaction."),
    el("label", { class: "field" }, [el("span", { class: "kicker" }, "From"), funder]),
    lines,
    el("div", { class: "row" }, [more, typed, send]),
  ]);
}

function bookView() {
  const rows = desk.launches.map((launch) => el("tr", {}, [
    el("td", {}, launch.symbol),
    el("td", {}, launch.venue),
    el("td", {}, launch.network),
    el("td", { class: "mono" }, launch.mint || "—"),
    el("td", {}, tradeCell(launch)),
  ]));
  return el("section", {}, [
    el("header", { class: "stage-head" }, el("h2", {}, "Book")),
    el("p", { class: noticeOk ? "ok" : "error", "data-notice": "1" }, notice),
    desk.launches.length
      ? el("table", {}, [
        el("thead", {}, el("tr", {}, ["Ticker", "Venue", "Network", "Mint", "Trade"].map((label) => el("th", {}, label)))),
        el("tbody", {}, rows),
      ])
      : el("p", { class: "hint" }, "Launches you send show up here."),
  ]);
}

function tradeCell(launch) {
  if (launch.venue !== "pump" && launch.venue !== "robinhood") return el("span", { class: "hint" }, "Record");
  const side = el("select", {}, [el("option", { value: "buy" }, "Buy"), el("option", { value: "sell" }, "Sell")]);
  const amount = el("input", { placeholder: launch.venue === "pump" ? "SOL or %" : "Amount", inputmode: "decimal" });
  const wallets = (launch.wallets || []).filter((row) => desk.wallets.some((item) => item.id === row.id));
  const picked = new Set(wallets.map((row) => row.id));
  const list = el("div", {}, wallets.map((row) => {
    const box = el("input", { type: "checkbox", checked: true });
    box.addEventListener("change", () => { box.checked ? picked.add(row.id) : picked.delete(row.id); });
    return el("label", { class: "row" }, [box, row.address ? short(row.address) : row.id]);
  }));
  const confirm = el("input", { placeholder: launch.symbol, autocomplete: "off" });
  const button = el("button", { class: "btn small primary", type: "button" }, "Send");
  const live = launch.network === "mainnet" || launch.network === "mainnet-beta" || launch.venue === "robinhood";
  const hint = el("p", { class: "hint" }, tradeHint(launch, "buy"));
  side.addEventListener("change", () => { hint.textContent = tradeHint(launch, side.value); });
  button.addEventListener("click", async () => {
    try {
      if (live && confirm.value.trim() !== launch.symbol) throw new Error(`Type ${launch.symbol} to send this.`);
      const result = await api("/api/trade", {
        method: "POST",
        body: {
          launchId: launch.id,
          walletIds: [...picked],
          side: side.value,
          amount: amount.value,
          spend: true,
          confirm: confirm.value.trim(),
        },
      });
      say(`Trade sent. ${(result.signatures || result.hashes || []).length} transaction(s).`, true);
    } catch (error) {
      say(error.message);
    }
  });
  return el("div", { class: "panel" }, [
    side,
    amount,
    list,
    live ? confirm : null,
    hint,
    button,
  ]);
}

function tradeHint(launch, side) {
  if (launch.venue === "pump" && side === "sell") return "Sell amount is a percent of that wallet, up to 100.";
  if (launch.venue === "pump") return "Buy amount is SOL.";
  if (side === "sell") return "Sell amount is tokens.";
  return "Buy amount is ETH.";
}

function settingsView() {
  const current = desk.settings;
  const fields = {
    solanaCluster: current.solanaCluster,
    solanaRpc: current.solanaRpc,
    solanaMainnetRpc: current.solanaMainnetRpc,
    robinhoodRpc: current.robinhoodRpc,
    hyperliquidNetwork: current.hyperliquidNetwork,
    jitoTipSol: current.jitoTipSol,
    slippageBps: String(current.slippageBps ?? 100),
    tlpxMint: current.tlpxMint || "",
  };
  const form = el("div", { class: "panel" });
  const inputs = {};
  for (const [key, label] of [
    ["solanaCluster", "Solana cluster"],
    ["solanaRpc", "Devnet RPC"],
    ["solanaMainnetRpc", "Mainnet RPC"],
    ["robinhoodRpc", "Robinhood RPC"],
    ["hyperliquidNetwork", "Hyperliquid"],
    ["jitoTipSol", "Jito tip, SOL"],
    ["slippageBps", "Slippage, bps"],
    ["tlpxMint", "$TLPX mint"],
  ]) {
    const input = el("input", { value: fields[key] ?? "" });
    inputs[key] = input;
    form.append(el("label", { class: "field" }, [el("span", { class: "kicker" }, label), input]));
  }
  const save = el("button", { class: "btn primary", type: "button" }, "Save");
  save.addEventListener("click", async () => {
    try {
      const body = {};
      for (const key of Object.keys(inputs)) body[key] = inputs[key].value.trim();
      const saved = await api("/api/settings", { method: "POST", body });
      desk.settings = saved.settings;
      say("Saved.", true);
    } catch (error) {
      say(error.message);
    }
  });
  form.append(save);
  return el("section", {}, [
    el("header", { class: "stage-head" }, el("h2", {}, "Settings")),
    el("p", { class: noticeOk ? "ok" : "error", "data-notice": "1" }, notice),
    form,
  ]);
}

async function loadBalances() {
  const data = await api(`/api/balances?network=${encodeURIComponent(desk.settings.solanaCluster || "devnet")}`, { auth: false });
  balances = Object.fromEntries((data.balances || []).map((row) => [row.id, row]));
  if (view === "wallets") render();
}

async function refresh(paint = true) {
  desk = await api("/api/state");
  if (desk.locked) {
    session = "";
    sessionStorage.removeItem("keel.session");
  }
  if (paint) render();
}

refresh().catch(() => render());
