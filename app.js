const definitions = {
  students: { title: "Students", singular: "student", description: "Registration records and student contact details.", columns: [["name", "Student"], ["id", "Student ID"], ["grade", "Grade"], ["guardian", "Parent / guardian"], ["phone", "Contact"], ["area", "Transport area"], ["status", "Status"]], fields: [["name", "Student name", "text", true], ["grade", "Grade", "text", true], ["guardian", "Parent / guardian", "text", true], ["phone", "Guardian phone", "tel", true], ["area", "Transport area", "text", false], ["status", "Registration status", "select", true, ["Active", "Pending"]]] },
  parents: { title: "Parents & guardians", singular: "parent", description: "Keep parent contacts connected to their students.", columns: [["name", "Parent / guardian"], ["id", "Record ID"], ["student", "Student"], ["relationship", "Relationship"], ["phone", "Phone"], ["email", "Email"]], fields: [["name", "Full name", "text", true], ["student", "Student", "text", true], ["relationship", "Relationship", "text", true], ["phone", "Phone", "tel", true], ["email", "Email", "email", false]] },
  staff: { title: "Staff directory", singular: "staff member", description: "Teachers and school workers.", columns: [["name", "Name"], ["id", "Staff ID"], ["role", "Role"], ["phone", "Phone"], ["email", "Email"]], fields: [["name", "Full name", "text", true], ["role", "Role", "text", true], ["phone", "Phone", "tel", true], ["email", "Work email", "email", true]] },
  items: { title: "School items", singular: "item", description: "Prices, stock, and required or optional student items.", columns: [["name", "Item"], ["id", "Item ID"], ["category", "Category"], ["price", "Unit price"], ["required", "Requirement"], ["stock", "In stock"]], fields: [["name", "Item name", "text", true], ["category", "Category", "text", true], ["price", "Unit price ($)", "number", true], ["required", "Requirement", "select", true, ["Required", "Optional"]], ["stock", "Quantity in stock", "number", true]] },
  distributions: { title: "Item distribution", singular: "distribution", description: "Track items collected by students and returned items. Stock adjusts automatically.", columns: [["student", "Student"], ["item", "Item"], ["id", "Record ID"], ["quantity", "Qty issued"], ["issued", "Date issued"], ["returned", "Qty returned"], ["status", "Status"]], fields: [["student", "Student", "text", true], ["item", "Item", "text", true], ["quantity", "Quantity issued", "number", true], ["issued", "Date issued", "date", true], ["returned", "Quantity returned", "number", true]] },
  payments: { title: "Registration payments", singular: "payment", description: "Record payments for registered items and services — not general school fees.", columns: [["id", "Receipt"], ["student", "Student"], ["purpose", "For"], ["amount", "Amount"], ["method", "Method"], ["date", "Date"], ["status", "Status"]], fields: [["student", "Student", "text", true], ["purpose", "Payment purpose", "text", true], ["amount", "Amount ($)", "number", true], ["method", "Payment method", "select", true, ["Cash", "Mobile money", "Bank transfer", "Card"]], ["date", "Payment date", "date", true], ["status", "Status", "select", true, ["Paid", "Pending"]]] },
  transport: { title: "Transport areas", singular: "transport area", description: "Service areas, transport prices, and driver assignments.", columns: [["area", "Area"], ["id", "Route ID"], ["fee", "Price / month"], ["capacity", "Capacity"], ["driver", "Assigned driver"], ["status", "Status"]], fields: [["area", "Transport area", "text", true], ["fee", "Price per month ($)", "number", true], ["capacity", "Seat capacity", "number", true], ["driver", "Assigned driver", "text", false], ["status", "Availability", "select", true, ["Available", "Full", "Inactive"]]] }
};

const navigation = [
  { label: "OVERVIEW", items: [["dashboard", "Overview", "◫"]] },
  { label: "REGISTRATION", items: [["students", "Students", "♙"], ["parents", "Parents & guardians", "♧"], ["staff", "Staff directory", "♧"]] },
  { label: "SCHOOL ITEMS", items: [["items", "Item catalogue", "▤"], ["distributions", "Item distribution", "⇄"], ["payments", "Payments", "＄"]] },
  { label: "TRANSPORT", items: [["transport", "Transport areas", "⌁"]] }
];

const collections = Object.keys(definitions);
const pageSize = 50;
let data = Object.fromEntries(collections.map((key) => [key, []]));
let recordTotals = Object.fromEntries(collections.map((key) => [key, 0]));
let dashboardStats = {};
let activePage = "dashboard";
let activeQuery = "";
let activeOffset = 0;
const activeFilters = Object.fromEntries(collections.map((key) => [key, { field: "", value: "" }]));
let currentUser = null;
let csrfToken = "";
let appReady = false;
let searchTimeout;
let searchSequence = 0;
let toastTimeout;

function canReadCollection(key) {
  if (currentUser?.role === "admin") return true;
  if (currentUser?.role === "registrar") return ["students", "parents", "payments"].includes(key);
  if (currentUser?.role === "inventory") return ["items", "distributions", "transport"].includes(key);
  return currentUser?.role === "viewer" && ["items", "transport"].includes(key);
}

function canWriteCollection(key) {
  return currentUser?.role === "admin" ||
    (currentUser?.role === "registrar" && ["students", "parents", "payments"].includes(key)) ||
    (currentUser?.role === "inventory" && ["items", "distributions", "transport"].includes(key));
}

function canDeleteCollection(key) {
  return currentUser?.role === "admin";
}

async function apiRequest(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body) headers.set("Content-Type", "application/json");
  if (options.method && options.method !== "GET" && csrfToken) headers.set("X-CSRF-Token", csrfToken);
  const response = await fetch(`/api${path}`, { ...options, headers, credentials: "same-origin" });
  const payload = response.status === 204 ? {} : await response.json().catch(() => ({}));
  if (response.status === 401 && path !== "/auth/login") {
    currentUser = null;
    csrfToken = "";
    if (activePage !== "website") render();
    const error = new Error("Your session has ended. Sign in again to continue.");
    error.status = 401;
    throw error;
  }
  if (!response.ok) {
    const error = new Error(payload.error || `The request failed (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

async function loadWorkspace() {
  try {
    const session = await apiRequest("/auth/me");
    currentUser = session.user || null;
    csrfToken = session.csrfToken || "";
    if (currentUser) await loadAllRecords();
  } catch (error) {
    if (error.status !== 401) {
      console.error("Could not connect to the SMIS server.", error);
      appReady = true;
      render();
      showToast(`Could not connect to the server: ${error.message}`);
      return;
    }
  }
  appReady = true;
  render();
}

async function loadAllRecords() {
  const allowed = collections.filter(canReadCollection);
  const [results, stats] = await Promise.all([
    Promise.all(allowed.map((key) => {
      const parameters = new URLSearchParams({ limit: String(pageSize), offset: "0" });
      const filter = activeFilters[key];
      if (filter?.field && filter.value) parameters.set(filter.field, filter.value);
      return apiRequest(`/${key}?${parameters}`);
    })),
    apiRequest("/dashboard")
  ]);
  data = Object.fromEntries(collections.map((key) => [key, []]));
  recordTotals = Object.fromEntries(collections.map((key) => [key, 0]));
  allowed.forEach((key, index) => {
    data[key] = results[index].records || [];
    recordTotals[key] = Number(results[index].total) || data[key].length;
  });
  dashboardStats = stats;
}

async function loadCollection(key, query = activeQuery, offset = activeOffset) {
  const parameters = new URLSearchParams({ limit: String(pageSize), offset: String(offset) });
  if (query) parameters.set("q", query);
  const filter = activeFilters[key];
  if (filter?.field && filter.value) parameters.set(filter.field, filter.value);
  const result = await apiRequest(`/${key}?${parameters}`);
  data[key] = result.records || [];
  recordTotals[key] = Number(result.total) || 0;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function money(value) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(Number(value) || 0);
}

function badge(value) {
  const modifier = String(value || "").toLowerCase().replace(/[^a-z]+/g, "-");
  return `<span class="badge badge-${modifier}"><i></i>${escapeHtml(value || "—")}</span>`;
}

function shortDate(value) {
  if (!value) return "—";
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.valueOf()) ? escapeHtml(value) : new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" }).format(date);
}

function render() {
  document.title = activePage === "website" ? "Brightwood School" : "SMIS — School Management";
  const root = document.querySelector("#app");
  root.innerHTML = activePage === "website" ? renderWebsite() : !appReady ? renderLoading() : !currentUser ? renderLogin() : renderShell();
  bindPageEvents();
}

function renderLoading() {
  return `<main class="auth-page"><section class="auth-card"><span class="brand-mark">b.</span><h1>Connecting to your school</h1><p>Loading your secure workspace…</p></section></main>`;
}

function renderLogin() {
  return `<main class="auth-page"><form class="auth-card" id="login-form"><span class="brand-mark">b.</span><span class="eyebrow">BRIGHTWOOD SCHOOL</span><h1>Welcome back</h1><p>Sign in to your staff workspace.</p><label class="form-field"><span>Work email</span><input name="email" type="email" autocomplete="username" required /></label><label class="form-field"><span>Password</span><input name="password" type="password" autocomplete="current-password" required /></label><div class="auth-error" id="auth-error" role="alert"></div><button class="button button-primary auth-submit" type="submit">Sign in <span>↗</span></button><a class="auth-public-link" href="#" data-page="website">Visit the public school website →</a></form></main>`;
}

function renderShell() {
  const current = activePage === "dashboard" ? "dashboard" : activePage;
  const nav = navigation.map((group) => `
    <div class="nav-group">
      <div class="nav-label">${group.label}</div>
      ${group.items.filter(([id]) => id === "dashboard" || canReadCollection(id)).map(([id, label, icon]) => `<button class="nav-link ${current === id ? "is-active" : ""}" data-page="${id}"><span class="nav-icon">${icon}</span><span>${label}</span>${id === "students" ? `<span class="nav-count">${recordTotals.students}</span>` : ""}</button>`).join("")}
    </div>
  `).filter((group) => group.includes("nav-link")).join("");
  return `
    <div class="app-shell">
      <aside class="sidebar">
        <a class="brand" href="#" data-page="dashboard" aria-label="SMIS overview"><span class="brand-mark">b.</span><span class="brand-copy"><strong>brightwood</strong><small>MANAGEMENT SYSTEM</small></span></a>
        <div class="school-switcher"><span class="school-avatar">B</span><span><strong>Brightwood School</strong><small>School workspace</small></span><span class="switch-arrow">⌄</span></div>
        <nav class="primary-nav" aria-label="Main navigation">${nav}</nav>
        <div class="sidebar-bottom"><div class="help-card"><span class="help-icon">✳</span><strong>Here to help</strong><p>Questions about your school records?</p><a href="mailto:hello@brightwood.edu">Contact support <span>↗</span></a></div><div class="profile"><div class="profile-avatar">${initials(currentUser?.name || currentUser?.email)}</div><span><strong>${escapeHtml(currentUser?.name || currentUser?.email)}</strong><small>${escapeHtml(roleName(currentUser?.role))}</small></span><button class="more-button" aria-label="More profile options">···</button></div></div>
      </aside>
      <main class="main-panel">
        <header class="topbar"><div class="breadcrumb">Brightwood School <span>/</span> <strong>${activePage === "dashboard" ? "Overview" : definitions[activePage]?.title || "Overview"}</strong></div><div class="topbar-actions"><span class="today-label">${new Intl.DateTimeFormat("en", { weekday: "short", month: "short", day: "numeric" }).format(new Date())}</span><button class="website-button" data-page="website"><span>↗</span> Public website</button><button class="signout-button" id="signout-button">Sign out</button></div></header>
        <section class="page-content">${activePage === "dashboard" ? renderDashboard() : renderListPage(activePage)}</section>
        <footer class="data-note"><span>◈</span> Secure school workspace · Changes are saved to your school database.</footer>
      </main>
    </div>`;
}

function renderDashboard() {
  const studentCount = Number(dashboardStats.students?.count ?? recordTotals.students);
  const itemCount = Number(dashboardStats.items?.count ?? recordTotals.items);
  const transportCount = Number(dashboardStats.transport?.count ?? recordTotals.transport);
  const paid = Number(dashboardStats.payments?.paid_total ?? data.payments.filter((payment) => payment.status === "Paid").reduce((total, payment) => total + Number(payment.amount || 0), 0));
  const monthly = Number(dashboardStats.payments?.monthly_total ?? data.payments.filter((payment) => payment.status === "Paid").reduce((total, payment) => total + Number(payment.amount || 0), 0));
  const pending = canReadCollection("students") ? Number(dashboardStats.students?.pending ?? data.students.filter((student) => student.status === "Pending").length) : null;
  const lowStock = canReadCollection("items") ? Number(dashboardStats.items?.low_stock ?? data.items.filter((item) => Number(item.stock) < 20).length) : null;
  const summaryCards = [
    canReadCollection("students") ? summaryCard("♙", "Registered students", studentCount, `${pending} pending registration`, "peach") : "",
    canReadCollection("items") ? summaryCard("▤", "School items", itemCount, `${lowStock} running low on stock`, "lavender") : "",
    canReadCollection("payments") ? summaryCard("＄", "Payments collected", money(paid), `${money(monthly)} recorded this month`, "mint") : "",
    canReadCollection("transport") ? summaryCard("⌁", "Transport areas", transportCount, `${Number(dashboardStats.transport?.available ?? data.transport.filter((route) => route.status === "Available").length)} areas available`, "blue") : ""
  ].filter(Boolean);
  const attentionItems = [
    pending !== null ? `<button class="attention-item" data-page="students"><span class="attention-symbol orange">!</span><span><strong>${pending} registration${pending === 1 ? "" : "s"} pending</strong><small>Review student information</small></span><span class="chevron">›</span></button>` : "",
    lowStock !== null ? `<button class="attention-item" data-page="items"><span class="attention-symbol purple">⌁</span><span><strong>${lowStock} item${lowStock === 1 ? "" : "s"} running low</strong><small>Check catalogue stock levels</small></span><span class="chevron">›</span></button>` : ""
  ].filter(Boolean);
  const recentPayments = canReadCollection("payments");
  const recentDistributions = !recentPayments && canReadCollection("distributions");
  const recent = recentPayments
    ? dashboardStats.payments?.recent || [...data.payments].slice(-4).reverse()
    : recentDistributions
      ? dashboardStats.distributions?.recent || [...data.distributions].slice(-4).reverse()
      : [];
  return `
    <div class="welcome-row"><div><span class="eyebrow">${new Intl.DateTimeFormat("en", { weekday: "long", month: "long", day: "numeric", year: "numeric" }).format(new Date()).toUpperCase()}</span><h1>Good morning, ${escapeHtml(currentUser?.name || currentUser?.email || "there")} <span>✳</span></h1><p>Here’s what’s happening at your school today.</p></div>${canWriteCollection("students") ? `<button class="button button-primary" data-open-form="students">＋ Register a student</button>` : ""}</div>
    <div class="summary-grid">${summaryCards.join("")}</div>
    <div class="dashboard-grid">
      <section class="panel activity-panel"><div class="panel-heading"><div><span class="eyebrow">LATEST ACTIVITY</span><h2>${recentPayments ? "Recent payments" : recentDistributions ? "Recent item distribution" : "Recent activity"}</h2></div>${recentPayments || recentDistributions ? `<button class="text-link" data-page="${recentPayments ? "payments" : "distributions"}">View all <span>→</span></button>` : ""}</div>
        ${recent.length ? `<div class="activity-list">${recent.map((record) => `<div class="activity-row"><div class="activity-icon">${recentPayments ? "＄" : "⇄"}</div><div class="activity-copy"><strong>${escapeHtml(record.student)}</strong><small>${escapeHtml(recentPayments ? record.purpose : record.item)} · ${shortDate(recentPayments ? record.date : record.issued)}</small></div><div class="activity-amount">${recentPayments ? money(record.amount) : `${record.quantity} issued`}<small>${badge(record.status)}</small></div></div>`).join("")}</div>` : emptyState(recentPayments ? "No payments recorded yet." : recentDistributions ? "No recent item distributions." : "Activity details are not available for this staff role.")}
      </section>
      <section class="panel attention-panel"><div class="panel-heading"><div><span class="eyebrow">QUICK CHECK</span><h2>Needs attention</h2></div><span class="attention-count">${attentionItems.length ? (pending || 0) + (lowStock || 0) : "—"}</span></div>
        ${attentionItems.length ? attentionItems.join("") : emptyState("No checks available for this staff role.")}
      </section>
    </div>
    ${canReadCollection("students") ? `<section class="panel roster-panel"><div class="panel-heading"><div><span class="eyebrow">SCHOOL COMMUNITY</span><h2>Recently registered students</h2></div><button class="text-link" data-page="students">All students <span>→</span></button></div>
      <div class="table-wrap"><table><thead><tr><th>STUDENT</th><th>GRADE</th><th>PARENT / GUARDIAN</th><th>TRANSPORT AREA</th><th>STATUS</th></tr></thead><tbody>${(dashboardStats.students?.recent || [...data.students].slice(-4).reverse()).map((student) => `<tr><td><div class="person-cell"><span class="table-avatar">${initials(student.name)}</span><span><strong>${escapeHtml(student.name)}</strong><small>${escapeHtml(student.id)}</small></span></div></td><td>${escapeHtml(student.grade)}</td><td>${escapeHtml(student.guardian)}</td><td>${escapeHtml(student.area || "—")}</td><td>${badge(student.status)}</td></tr>`).join("")}</tbody></table></div>
    </section>` : ""}
  `;
}

function summaryCard(icon, title, value, detail, color) {
  return `<article class="summary-card"><div class="summary-top"><span class="summary-icon ${color}">${icon}</span><span class="summary-menu">···</span></div><div class="summary-title">${title}</div><div class="summary-value">${escapeHtml(value)}</div><div class="summary-detail">${detail}</div></article>`;
}

function initials(name) {
  return String(name || "").split(/\s+/).slice(0, 2).map((part) => part.charAt(0)).join("").toUpperCase();
}

function roleName(role) {
  return ({ admin: "School administrator", registrar: "Registrar", inventory: "Inventory manager", viewer: "Read-only staff" })[role] || "School staff";
}

function emptyState(text) {
  return `<div class="empty-state">${escapeHtml(text)}</div>`;
}

function renderListPage(key) {
  const definition = definitions[key];
  if (!definition) return renderDashboard();
  const records = data[key] || [];
  const totalRecords = Number(recordTotals[key] ?? records.length);
  const pageCount = Math.max(1, Math.ceil(totalRecords / pageSize));
  const currentPage = Math.floor(activeOffset / pageSize) + 1;
  return `
    <div class="page-heading"><div><span class="eyebrow">SCHOOL RECORDS</span><h1>${definition.title}</h1><p>${definition.description}</p></div>${canWriteCollection(key) ? `<button class="button button-primary" data-open-form="${key}">＋ Add ${definition.singular}</button>` : ""}</div>
    ${key === "distributions" ? `<div class="inline-note"><span>↗</span> Record items as they are issued or returned. Available stock is adjusted automatically.</div>` : ""}
    ${key === "payments" ? `<div class="inline-note"><span>ⓘ</span> This module is for item and service registration payments only. It does not manage general school fees.</div>` : ""}
    <section class="panel records-panel"><div class="records-toolbar"><div class="record-count"><strong>${totalRecords}</strong> ${totalRecords === 1 ? "record" : "records"}<span> in ${definition.title.toLowerCase()}</span></div><label class="search-box"><span>⌕</span><input type="search" id="record-search" placeholder="Search ${definition.title.toLowerCase()}..." value="${escapeHtml(activeQuery)}" aria-label="Search ${definition.title.toLowerCase()}"></label><button class="filter-button" id="filter-toggle" aria-expanded="false" aria-controls="filter-controls">☷ <span>Filter${activeFilters[key].value ? " · 1" : ""}</span></button></div>
      <div class="filter-controls" id="filter-controls" hidden><label for="filter-field">Field</label><select id="filter-field"><option value="">Choose a field</option>${definition.columns.map(([field, label]) => `<option value="${field}" ${activeFilters[key].field === field ? "selected" : ""}>${escapeHtml(label)}</option>`).join("")}</select><label for="filter-value">Exact match</label><input id="filter-value" type="search" value="${escapeHtml(activeFilters[key].value)}" placeholder="Enter a value" /><button class="button button-primary" data-apply-filter>Apply</button><button class="button button-quiet" data-clear-filter>Clear</button></div>
      <div class="table-wrap"><table><thead><tr>${definition.columns.map(([, label]) => `<th>${escapeHtml(label.toUpperCase())}</th>`).join("")}<th><span class="sr-only">ACTIONS</span></th></tr></thead><tbody>
        ${records.map((record) => `<tr>${definition.columns.map(([field]) => `<td>${formatCell(field, record[field])}</td>`).join("")}<td><div class="row-actions">${canWriteCollection(key) ? `<button class="row-action" data-edit="${escapeHtml(record.id)}" data-edit-key="${key}" aria-label="Edit ${escapeHtml(definition.singular)} ${escapeHtml(record.id)}">Edit</button>` : ""}${canDeleteCollection(key) ? `<button class="row-action row-delete" data-delete="${escapeHtml(record.id)}" data-delete-key="${key}" aria-label="Delete ${escapeHtml(definition.singular)} ${escapeHtml(record.id)}">Delete</button>` : ""}</div></td></tr>`).join("")}
        ${records.length ? "" : `<tr><td colspan="${definition.columns.length + 1}">${emptyState(activeQuery ? "No matching records found." : `No ${definition.title.toLowerCase()} added yet.`)}</td></tr>`}
      </tbody></table></div><div class="table-footer"><span>Showing ${records.length ? activeOffset + 1 : 0}–${activeOffset + records.length} of ${totalRecords} records</span><div class="table-pagination"><button class="page-button" data-offset="${Math.max(0, activeOffset - pageSize)}" ${activeOffset === 0 ? "disabled" : ""}>Previous</button><span>Page ${currentPage} of ${pageCount}</span><button class="page-button" data-offset="${activeOffset + pageSize}" ${currentPage >= pageCount ? "disabled" : ""}>Next</button></div></div>
    </section>`;
}

function formatCell(field, value) {
  if (field === "name" && value) return `<strong class="cell-strong">${escapeHtml(value)}</strong>`;
  if (field === "status" || field === "required") return badge(value);
  if (field === "price" || field === "amount" || field === "fee") return `<span class="cell-strong">${money(value)}</span>`;
  if (field === "date" || field === "issued") return shortDate(value);
  if (field === "stock" && Number(value) < 20) return `<span class="stock-low">${escapeHtml(value)} <small>Low stock</small></span>`;
  return escapeHtml(value === "" || value == null ? "—" : value);
}

function renderWebsite() {
  return `<div class="public-site"><header class="public-nav"><a href="#" class="public-brand"><span class="brand-mark">b.</span><strong>BRIGHTWOOD <span>SCHOOL</span></strong></a><nav><a href="#our-school">Our school</a><a href="#learning">Learning</a><a href="#contact">Contact</a></nav><button class="button button-primary" data-page="dashboard">Staff sign in <span>↗</span></button></header>
    <main><section class="public-hero"><div class="hero-copy"><span class="eyebrow">A PLACE TO GROW, EVERY DAY</span><h1>Big futures<br />start <em>right here.</em></h1><p>Curious minds. Kind hearts. A community where every child finds their own way to shine.</p><div class="hero-actions"><a class="button button-primary" href="#contact">Discover Brightwood <span>↗</span></a><a class="hero-secondary" href="#our-school">Get to know us <span>↓</span></a></div><div class="hero-proof"><div class="proof-avatars"><span>G</span><span>A</span><span>M</span></div><p><strong>A school community</strong><br />built around every child</p></div></div><div class="hero-art"><div class="hero-image"><div class="sun"></div><div class="hill hill-back"></div><div class="hill hill-front"></div><div class="art-label"><span>✳</span><div><strong>Room to explore</strong><small>Learning looks different for everyone</small></div></div><span class="art-caption">BRIGHTWOOD · EST. 1998</span></div><span class="doodle doodle-one">✳</span><span class="doodle doodle-two">↗</span><span class="hero-sticker">A SCHOOL<br />THAT FEELS<br />LIKE HOME</span></div></section>
    <section class="public-values" id="our-school"><div><span class="value-icon">⌂</span><strong>A welcoming community</strong><small>Every family belongs here.</small></div><div><span class="value-icon">✳</span><strong>Curiosity comes first</strong><small>Discover what you love to learn.</small></div><div><span class="value-icon">♡</span><strong>Care in every detail</strong><small>Growing together, every day.</small></div></section>
    <section class="public-about" id="learning"><div class="about-heading"><span class="eyebrow">A LITTLE ABOUT US</span><h2>More than a school.<br /><em>A place to belong.</em></h2></div><div class="about-copy"><p>At Brightwood, learning is an adventure we take together. Our teachers create a thoughtful, joyful environment where children can ask big questions, try new things, and build the confidence to be themselves.</p><a href="#contact" class="text-link">Come say hello <span>→</span></a></div></section>
    <section class="public-contact" id="contact"><div><span class="eyebrow">YOUR NEXT CHAPTER STARTS HERE</span><h2>We’d love to meet you.</h2><p>Talk to our friendly team about school visits and registration.</p></div><a class="button button-light" href="mailto:hello@brightwood.edu">Get in touch <span>↗</span></a></section></main><footer class="public-footer"><a href="#" class="public-brand"><span class="brand-mark">b.</span><strong>BRIGHTWOOD <span>SCHOOL</span></strong></a><span>© ${new Date().getFullYear()} Brightwood School</span><a href="mailto:hello@brightwood.edu">hello@brightwood.edu</a></footer></div>`;
}

function bindPageEvents() {
  document.querySelectorAll("[data-page]").forEach((button) => button.addEventListener("click", (event) => {
    event.preventDefault();
    activePage = button.dataset.page;
    activeQuery = "";
    activeOffset = 0;
    render();
    window.scrollTo({ top: 0, behavior: "smooth" });
    if (currentUser && activePage !== "website") {
      loadAllRecords().then(render).catch((error) => showToast(`Could not refresh records: ${error.message}`));
    }
  }));
  document.querySelectorAll("[data-open-form]").forEach((button) => button.addEventListener("click", () => openForm(button.dataset.openForm)));
  document.querySelectorAll("[data-edit]").forEach((button) => button.addEventListener("click", () => {
    const key = button.dataset.editKey;
    openForm(key, data[key]?.find((record) => record.id === button.dataset.edit));
  }));
  document.querySelectorAll("[data-delete]").forEach((button) => button.addEventListener("click", () => deleteRecord(button.dataset.deleteKey, button.dataset.delete)));
  document.querySelectorAll("[data-offset]").forEach((button) => button.addEventListener("click", async () => {
    activeOffset = Number(button.dataset.offset);
    try {
      await loadCollection(activePage);
      render();
    } catch (error) {
      showToast(`Could not load records: ${error.message}`);
    }
  }));
  const filterToggle = document.querySelector("#filter-toggle");
  if (filterToggle) filterToggle.addEventListener("click", () => {
    const controls = document.querySelector("#filter-controls");
    const expanded = controls.hidden;
    controls.hidden = !expanded;
    filterToggle.setAttribute("aria-expanded", String(expanded));
  });
  const applyFilter = document.querySelector("[data-apply-filter]");
  if (applyFilter) applyFilter.addEventListener("click", async () => {
    const field = document.querySelector("#filter-field").value;
    const value = document.querySelector("#filter-value").value.trim();
    if (!field && value) {
      showToast("Choose a field before applying the filter.");
      return;
    }
    activeFilters[activePage] = { field, value };
    activeOffset = 0;
    try {
      await loadCollection(activePage, activeQuery, 0);
      render();
    } catch (error) {
      showToast(`Could not apply the filter: ${error.message}`);
    }
  });
  const clearFilter = document.querySelector("[data-clear-filter]");
  if (clearFilter) clearFilter.addEventListener("click", async () => {
    activeFilters[activePage] = { field: "", value: "" };
    activeOffset = 0;
    try {
      await loadCollection(activePage, activeQuery, 0);
      render();
    } catch (error) {
      showToast(`Could not clear the filter: ${error.message}`);
    }
  });
  const loginForm = document.querySelector("#login-form");
  if (loginForm) loginForm.addEventListener("submit", submitLogin);
  const signout = document.querySelector("#signout-button");
  if (signout) signout.addEventListener("click", signOut);
  const search = document.querySelector("#record-search");
  if (search) search.addEventListener("input", () => {
    const position = search.selectionStart;
    activeQuery = search.value;
    const query = activeQuery;
    const collection = activePage;
    activeOffset = 0;
    const requestSequence = ++searchSequence;
    window.clearTimeout(searchTimeout);
    searchTimeout = window.setTimeout(async () => {
      try {
        await loadCollection(collection, query, 0);
        if (requestSequence !== searchSequence || activePage !== collection) return;
        const pageContent = document.querySelector(".page-content");
        if (!pageContent) return;
        pageContent.innerHTML = renderListPage(collection);
        bindPageEvents();
        const updatedInput = document.querySelector("#record-search");
        if (!updatedInput) return;
        updatedInput.focus();
        updatedInput.setSelectionRange(position, position);
      } catch (error) {
        if (requestSequence === searchSequence && activePage === collection) showToast(`Search failed: ${error.message}`);
      }
    }, 250);
  });
}

async function submitLogin(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button[type=submit]");
  const errorMessage = document.querySelector("#auth-error");
  button.disabled = true;
  errorMessage.textContent = "";
  try {
    const credentials = Object.fromEntries(new FormData(form).entries());
    const session = await apiRequest("/auth/login", { method: "POST", body: JSON.stringify(credentials) });
    currentUser = session.user;
    csrfToken = session.csrfToken || "";
    await loadAllRecords();
    activePage = "dashboard";
    activeOffset = 0;
    activeQuery = "";
    render();
  } catch (error) {
    errorMessage.textContent = error.status === 401 ? "Email or password is incorrect." : error.message;
    button.disabled = false;
  }
}

async function signOut() {
  try {
    await apiRequest("/auth/logout", { method: "POST", body: "{}" });
  } catch (error) {
    if (error.status !== 401) {
      showToast(`Could not sign out: ${error.message}`);
      return;
    }
  }
  currentUser = null;
  csrfToken = "";
  data = Object.fromEntries(collections.map((key) => [key, []]));
  recordTotals = Object.fromEntries(collections.map((key) => [key, 0]));
  dashboardStats = {};
  activePage = "dashboard";
  activeOffset = 0;
  activeQuery = "";
  collections.forEach((key) => { activeFilters[key] = { field: "", value: "" }; });
  render();
}

function openForm(key, record = null) {
  const definition = definitions[key];
  if (!definition) return;
  const dialog = document.querySelector("#record-dialog");
  document.querySelector("#dialog-title").textContent = record ? `Edit ${definition.singular}` : `Add ${definition.singular}`;
  document.querySelector("#form-fields").innerHTML = definition.fields.map(([field, label, type, required, options]) => {
    const control = type === "select"
      ? `<select name="${field}" ${required ? "required" : ""}>${options.map((option) => `<option ${record?.[field] === option ? "selected" : ""}>${escapeHtml(option)}</option>`).join("")}</select>`
      : `<input name="${field}" type="${type}" ${required ? "required" : ""} ${type === "number" ? `min="${field === "quantity" ? "1" : "0"}" step="${["stock", "quantity", "returned", "capacity"].includes(field) ? "1" : "any"}" value="${escapeHtml(record?.[field] ?? (field === "returned" ? 0 : ""))}"` : ""} ${type === "date" ? `value="${escapeHtml(record?.[field] || new Date().toISOString().slice(0, 10))}"` : ""} ${type !== "date" && type !== "number" && record?.[field] != null ? `value="${escapeHtml(record[field])}"` : ""} />`;
    return `<label class="form-field"><span>${escapeHtml(label)}${required ? " <i>*</i>" : ""}</span>${control}</label>`;
  }).join("");
  const form = document.querySelector("#record-form");
  form.dataset.recordKey = key;
  form.dataset.recordId = record?.id || "";
  form.querySelector("button[type=submit]").disabled = false;
  dialog.showModal();
}

document.querySelector("#record-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const key = form.dataset.recordKey;
  const values = Object.fromEntries(new FormData(form).entries());
  const definition = definitions[key];
  if (!definition) return;
  const button = form.querySelector("button[type=submit]");
  button.disabled = true;
  try {
    const editing = Boolean(form.dataset.recordId);
    const path = `/${key}${editing ? `/${encodeURIComponent(form.dataset.recordId)}` : ""}`;
    await apiRequest(path, { method: editing ? "PUT" : "POST", body: JSON.stringify(values) });
    if (!editing) {
      activeQuery = "";
      activeFilters[key] = { field: "", value: "" };
      activeOffset = 0;
    }
    await loadCollection(key);
    if (!editing && recordTotals[key] > pageSize) {
      activeOffset = Math.floor((recordTotals[key] - 1) / pageSize) * pageSize;
      await loadCollection(key);
    }
    dashboardStats = await apiRequest("/dashboard");
    if (!editing) activePage = key;
    document.querySelector("#record-dialog").close();
    form.reset();
    delete form.dataset.recordId;
    render();
    showToast(`${definition.singular.charAt(0).toUpperCase()}${definition.singular.slice(1)} ${editing ? "updated" : "added"} successfully.`);
  } catch (error) {
    showToast(`Could not save ${definition.singular}: ${error.message}`);
    button.disabled = false;
  }
});

document.querySelectorAll("[data-close-dialog]").forEach((button) => button.addEventListener("click", () => document.querySelector("#record-dialog").close()));

async function deleteRecord(key, id) {
  const definition = definitions[key];
  const record = data[key]?.find((item) => item.id === id);
  if (!definition || !record || !window.confirm(`Remove ${definition.singular} “${record.name || record.student || record.area || record.item || id}” from the school database?`)) return;
  try {
    await apiRequest(`/${key}/${encodeURIComponent(id)}`, { method: "DELETE" });
    await loadCollection(key);
    if (activeOffset >= recordTotals[key] && activeOffset > 0) {
      activeOffset = Math.max(0, Math.floor((recordTotals[key] - 1) / pageSize) * pageSize);
      await loadCollection(key);
    }
    dashboardStats = await apiRequest("/dashboard");
    render();
    showToast(`${definition.singular.charAt(0).toUpperCase()}${definition.singular.slice(1)} removed.`);
  } catch (error) {
    showToast(`Could not remove ${definition.singular}: ${error.message}`);
  }
}

function showToast(message) {
  const toast = document.querySelector("#toast");
  toast.textContent = message;
  toast.classList.add("is-visible");
  window.clearTimeout(toastTimeout);
  toastTimeout = window.setTimeout(() => toast.classList.remove("is-visible"), 2800);
}

render();
loadWorkspace();
