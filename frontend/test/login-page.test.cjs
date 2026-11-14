const { before, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const swc = require("next/dist/build/swc");

const compiled = {};
before(async () => {
  await swc.loadBindings();
  for (const relative of ["pages/login.js", "lib/branding.js"]) {
    const filename = path.join(__dirname, "..", relative);
    compiled[relative] = (await swc.transform(fs.readFileSync(filename, "utf8"), {
      filename,
      jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } } },
      module: { type: "commonjs" }
    })).code;
  }
});

const jsx = (type, props) => ({ type, props: props || {} });
const tick = () => new Promise(resolve => setImmediate(resolve));
const css = new Proxy({}, { get: (_target, key) => key === "__esModule" || typeof key === "symbol" ? undefined : key });
const cssSource = fs.readFileSync(path.join(__dirname, "../styles/login.module.css"), "utf8");
function SystemLogo() {}
function Head() {}

function nodes(tree, predicate, found = []) {
  if (Array.isArray(tree)) tree.forEach(child => nodes(child, predicate, found));
  else if (tree && typeof tree === "object" && tree.props) {
    if (predicate(tree)) found.push(tree);
    nodes(tree.props.children, predicate, found);
  }
  return found;
}
function text(tree) {
  if (tree == null || typeof tree === "boolean") return "";
  if (typeof tree === "string" || typeof tree === "number") return String(tree);
  if (Array.isArray(tree)) return tree.map(text).join("");
  return text(tree.props?.children);
}

async function mountLogin({ user = null, authLoading = false, login } = {}) {
  const hooks = [], dependencies = [], cleanups = [], pending = [];
  let cursor = 0;
  const react = {
    useState(initial) {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = typeof initial === "function" ? initial() : initial;
      return [hooks[index], next => { hooks[index] = typeof next === "function" ? next(hooks[index]) : next; }];
    },
    useRef(initial) { const index = cursor++; if (!(index in hooks)) hooks[index] = { current: initial }; return hooks[index]; },
    useEffect(callback, deps) {
      const index = cursor++, previous = dependencies[index];
      if (!previous || !deps || deps.some((value, i) => value !== previous[i])) {
        dependencies[index] = deps;
        pending.push(() => { cleanups[index]?.(); cleanups[index] = callback(); });
      }
    }
  };
  const branding = { exports: {} };
  vm.runInNewContext(compiled["lib/branding.js"], { module: branding, exports: branding.exports });
  const pushes = [], logins = [], focused = [];
  const auth = {
    user, loading: authLoading,
    login: async (id, password) => { logins.push([id, password]); return login ? login(id, password) : { success: true }; }
  };
  const router = { push: target => pushes.push(target) };
  const module = { exports: {} };
  vm.runInNewContext(compiled["pages/login.js"], {
    module, exports: module.exports, console: { error() {} },
    require(name) {
      if (name === "react") return react;
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "fragment" };
      if (name === "next/head") return Head;
      if (name === "next/router") return { useRouter: () => router };
      if (name === "../context/AuthContext") return { useAuth: () => auth };
      if (name === "../components/SystemLogo") return SystemLogo;
      if (name === "../lib/branding") return branding.exports;
      if (name === "../styles/login.module.css") return css;
      throw new Error(`Unexpected dependency: ${name}`);
    }
  });
  const page = {
    pushes, logins, focused, auth,
    render() {
      cursor = 0;
      const tree = module.exports.default();
      for (const node of nodes(tree, node => node.props.ref && typeof node.props.ref === "object")) {
        node.props.ref.current = { focus: () => focused.push(node.props.id) };
      }
      return page.tree = tree;
    },
    async settle() { for (let i = 0; i < 3; i++) { page.render(); pending.splice(0).forEach(effect => effect()); await tick(); } return page.render(); },
    field: id => nodes(page.render(), node => node.props.id === id)[0],
    type(id, value) { page.field(id).props.onChange({ target: { value } }); },
    submit() { let prevented = false; const done = nodes(page.render(), node => node.type === "form")[0].props.onSubmit({ preventDefault() { prevented = true; } }); return { done, prevented: () => prevented }; },
    button: label => nodes(page.render(), node => node.type === "button" && (text(node).trim() === label || node.props["aria-label"] === label))[0],
    alert: () => nodes(page.render(), node => node.props.role === "alert")[0]
  };
  await page.settle();
  return page;
}

test("the page shows the official office identity, the real building photo and the sign-in heading", async () => {
  const page = await mountLogin();
  const all = text(page.tree);
  assert.match(all, /Cabadbaran City Health Office/);
  assert.match(all, /and Family Planning Center/);
  assert.match(all, /Welcome back/);
  assert.match(all, /Sign in to access the Queue Management System\./);
  assert.match(text(nodes(page.tree, node => node.type === Head)[0]), /Sign in \| Cabadbaran City Health Office and Family Planning Center/);
  assert.doesNotMatch(all, /City Health Log-In Form|Smart Queuing System|Hospital|City Healthcare System|Municipal Health Office/);
  const photo = nodes(page.tree, node => node.type === "img")[0];
  assert.equal(photo.props.src, "/cho_img.jpg");
  assert.ok(fs.existsSync(path.join(__dirname, "../public/cho_img.jpg")), "the supplied photo is served from public/");
  assert.equal(photo.props.width, 1969);
  assert.equal(photo.props.height, 1146, "intrinsic size reserves space and prevents layout shift");
  assert.match(photo.props.alt, /City Health Office and Family Planning Center building/);
  assert.equal(nodes(page.tree, node => node.type === SystemLogo)[0].props.decorative, true, "the office name sits beside the logo");
  assert.equal(nodes(page.tree, node => node.type === "h1").length, 1);
});

test("the photo is never cropped, so the building sign and the photographer's watermark stay visible", () => {
  const photoRule = /\.photo\s*\{([^}]*)\}/.exec(cssSource)[1];
  assert.match(photoRule, /width:\s*100%/);
  assert.match(photoRule, /height:\s*auto/);
  assert.doesNotMatch(cssSource, /object-fit:\s*cover/);
  assert.doesNotMatch(cssSource, /\.photo[^{]*\{[^}]*filter/, "natural colors");
});

test("the layout is split on wide screens and a single column on tablets and phones", () => {
  assert.match(cssSource, /\.page\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*55fr\)\s*minmax\(0,\s*45fr\)/);
  const stacked = /@media \(max-width: 1023px\)\s*\{([\s\S]*?)\n\}/.exec(cssSource)[1];
  assert.match(stacked, /\.page\s*\{\s*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  assert.match(cssSource, /min-height:\s*100dvh/, "short screens and on-screen keyboards can scroll");
  assert.match(cssSource, /prefers-reduced-motion/);
  assert.doesNotMatch(cssSource, /border-radius:\s*(999|50)px|border-radius:\s*[2-9]\dpx/, "no capsule controls");
});

test("username and password fields are labelled, autocomplete-aware and keyboard ordered", async () => {
  const page = await mountLogin();
  const id = page.field("id_num"), password = page.field("password");
  const labelFor = target => text(nodes(page.tree, node => node.type === "label" && node.props.htmlFor === target)[0]);
  assert.equal(labelFor("id_num"), "Username / ID Number");
  assert.equal(labelFor("password"), "Password");
  assert.equal(id.props.autoComplete, "username");
  assert.equal(password.props.autoComplete, "current-password");
  assert.equal(password.props.type, "password");
  const order = nodes(page.tree, node => ["input", "button"].includes(node.type))
    .map(node => node.props.id || node.props["aria-label"] || text(node).trim());
  assert.deepEqual(order, ["id_num", "password", "Show password", "Sign in"]);
});

test("the eye button reveals and hides the password without submitting or losing it", async () => {
  const page = await mountLogin();
  page.type("password", "secret-value");
  const toggle = page.button("Show password");
  assert.equal(toggle.props.type, "button", "never submits the form");
  assert.equal(toggle.props["aria-controls"], "password");
  assert.equal(toggle.props["aria-pressed"], false);
  toggle.props.onClick();
  assert.equal(page.field("password").props.type, "text");
  assert.equal(page.field("password").props.value, "secret-value");
  assert.equal(page.button("Hide password").props["aria-pressed"], true);
  page.button("Hide password").props.onClick();
  assert.equal(page.field("password").props.type, "password");
  assert.equal(page.logins.length, 0);
});

test("empty fields are reported in words, marked invalid and focused, without calling login", async () => {
  const page = await mountLogin();
  page.submit();
  assert.match(text(page.alert()), /Please enter your username\/ID number/);
  assert.equal(page.field("id_num").props["aria-invalid"], true);
  assert.equal(page.field("id_num").props["aria-describedby"], "login-error");
  assert.equal(page.focused.at(-1), "id_num");
  page.type("id_num", "   ");
  page.submit();
  assert.match(text(page.alert()), /username\/ID number/, "whitespace is not an ID");
  page.type("id_num", "frontdesk");
  page.submit();
  assert.match(text(page.alert()), /Please enter your password/);
  assert.equal(page.field("password").props["aria-invalid"], true);
  assert.equal(page.field("id_num").props["aria-invalid"], undefined);
  assert.equal(page.focused.at(-1), "password");
  assert.equal(page.logins.length, 0);
});

test("submitting signs in once with the trimmed ID and shows a disabled loading state meanwhile", async () => {
  let finish;
  const page = await mountLogin({ login: () => new Promise(resolve => { finish = resolve; }) });
  page.type("id_num", "  admin2 ");
  page.type("password", " pass with spaces ");
  const first = page.submit();
  assert.ok(first.prevented(), "no page reload or credentials in the URL");
  const busy = page.render();
  assert.equal(page.field("id_num").props.disabled, true);
  assert.equal(page.field("password").props.disabled, true);
  const submit = nodes(busy, node => node.props.type === "submit")[0];
  assert.equal(submit.props.disabled, true);
  assert.match(text(submit), /Signing in…/);
  assert.equal(nodes(busy, node => node.type === "form")[0].props["aria-busy"], true);
  page.submit();
  assert.deepEqual(page.logins, [["admin2", " pass with spaces "]], "a second press does not send another login");
  finish({ success: true });
  await first.done;
  assert.equal(page.field("id_num").props.disabled, false);
  assert.equal(page.alert(), undefined);
});

test("server and network failures are announced to screen readers", async () => {
  const rejected = await mountLogin({ login: async () => ({ success: false, message: "Invalid credentials" }) });
  rejected.type("id_num", "admin1"); rejected.type("password", "wrong");
  await rejected.submit().done;
  assert.match(text(rejected.alert()), /Invalid credentials/);
  assert.equal(rejected.field("password").props.value, "wrong", "the typed password is kept for correction");

  const offline = await mountLogin({ login: async () => { throw new Error("fetch failed"); } });
  offline.type("id_num", "admin1"); offline.type("password", "x");
  await offline.submit().done;
  assert.match(text(offline.alert()), /Network error\. Please check your connection and try again\./);
});

test("signed-in accounts are sent to their existing home pages", async () => {
  const cases = [
    [{ id_num: "superadmin", role: "superadmin" }, "/"],
    [{ id_num: "admin1", role: "admin" }, "/admin1"],
    [{ id_num: "admin2", role: "admin" }, "/admin2"],
    [{ id_num: "admin3", role: "admin" }, "/admin3"],
    [{ id_num: "frontdesk", role: "admin" }, "/fill-up_form"],
    [{ id_num: "other", role: "admin" }, "/"]
  ];
  for (const [user, target] of cases) assert.deepEqual((await mountLogin({ user })).pushes, [target], user.id_num);
  assert.deepEqual((await mountLogin()).pushes, [], "a signed-out or expired session stays on the form");
});

test("while the session is being checked the form is not shown", async () => {
  const page = await mountLogin({ authLoading: true });
  assert.match(text(nodes(page.tree, node => node.props.role === "status")[0]), /Checking your session/);
  assert.equal(nodes(page.tree, node => node.type === "form").length, 0);
  assert.equal(page.pushes.length, 0);
});

test("there are no registration, recovery or demo-credential shortcuts, and no secrets on the page", async () => {
  const page = await mountLogin({ user: null });
  const all = text(page.tree);
  assert.doesNotMatch(all, /register|sign up|create account|forgot|reset password/i);
  assert.doesNotMatch(all, /admin00\d|frontdesk123|superadmin123|admin123|demo/i);
  assert.equal(nodes(page.tree, node => node.type === "a").length, 0);
  assert.doesNotMatch(JSON.stringify(page.tree), /token|Bearer|jwt/i);
  assert.equal(nodes(page.tree, node => node.type === "button").length, 2, "only the eye toggle and Sign in");
});
