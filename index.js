// CourseWise Admin uses Express routes and EJS templates, like the class CRUD examples.
// The server talks to Supabase so the app can reuse CourseWise Auth and database tables.
const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

// Small .env reader keeps local setup simple and avoids another runtime package.
// In Vercel, set the same values in the project's environment settings.
const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const equalsAt = trimmed.indexOf("=");
    if (equalsAt < 1) continue;
    const name = trimmed.slice(0, equalsAt).trim();
    let value = trimmed.slice(equalsAt + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[name] === undefined) process.env[name] = value;
  }
}

const app = express();
const port = process.env.PORT || 3000;
const supabaseUrl = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || "";
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const sessionSecret = process.env.SESSION_SECRET || "";
const sessionCookie = "coursewise.admin.sid";
const sessionLifetimeMs = 1000 * 60 * 60 * 8;
const effectiveSessionSecret = sessionSecret || "local-only-change-this-secret-before-deploying";

if ((process.env.NODE_ENV === "production" || process.env.VERCEL === "1") && !sessionSecret) {
  throw new Error("Set SESSION_SECRET in the hosting environment before starting CourseWise Admin.");
}

function useSecureCookies() {
  return process.env.NODE_ENV === "production" ||
    process.env.VERCEL_ENV === "production" ||
    process.env.VERCEL_ENV === "preview";
}

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
// Vercel serves public/ from its CDN; local Express serves the same files during development.
if (process.env.VERCEL !== "1") app.use(express.static(path.join(__dirname, "public")));
// Trust the HTTPS proxy so production cookies receive the Secure attribute.
app.set("trust proxy", 1);
app.use(express.urlencoded({ extended: true }));

function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: useSecureCookies(),
    path: "/"
  };
}

// The cookie carries a signed identity and expiry, so it works across stateless functions.
function createAdminCookie(admin) {
  const payload = Buffer.from(JSON.stringify({
    id: admin.id,
    email: admin.email,
    expiresAt: Date.now() + sessionLifetimeMs
  })).toString("base64url");
  const signature = crypto.createHmac("sha256", effectiveSessionSecret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function readAdminCookie(req) {
  const cookieHeader = req.headers.cookie || "";
  const cookiePair = cookieHeader.split(";").map(value => value.trim()).find(value => value.startsWith(`${sessionCookie}=`));
  if (!cookiePair) return null;

  try {
    const token = decodeURIComponent(cookiePair.slice(sessionCookie.length + 1));
    const separator = token.lastIndexOf(".");
    if (separator < 1) return null;
    const payload = token.slice(0, separator);
    const providedSignature = Buffer.from(token.slice(separator + 1), "base64url");
    const expectedSignature = crypto.createHmac("sha256", effectiveSessionSecret).update(payload).digest();
    if (providedSignature.length !== expectedSignature.length || !crypto.timingSafeEqual(providedSignature, expectedSignature)) return null;

    const admin = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!admin.id || !admin.email || !Number.isFinite(admin.expiresAt) || admin.expiresAt <= Date.now()) return null;
    return { id: String(admin.id), email: String(admin.email) };
  } catch {
    return null;
  }
}

function clearAdminCookie(res) {
  res.clearCookie(sessionCookie, cookieOptions());
}

function redirectWithNotice(res, message, type = "success") {
  const query = new URLSearchParams({ notice: message, noticeType: type });
  res.redirect(`/?${query.toString()}`);
}

// Recheck the existing admin table on every request so removed admins lose access promptly.
app.use(async (req, res, next) => {
  const hasAdminCookie = (req.headers.cookie || "").split(";").some(value => value.trim().startsWith(`${sessionCookie}=`));
  req.admin = readAdminCookie(req);
  req.adminCheckError = null;
  if (hasAdminCookie && !req.admin) clearAdminCookie(res);
  if (req.admin) {
    try {
      if (!await isCourseWiseAdmin(req.admin.id)) {
        req.admin = null;
        clearAdminCookie(res);
      }
    } catch (error) {
      req.admin = null;
      req.adminCheckError = error;
    }
  }
  res.locals.loggedIn = Boolean(req.admin);
  res.locals.adminEmail = req.admin?.email || "";
  res.locals.notice = req.query.notice || "";
  res.locals.noticeType = req.query.noticeType || "success";
  next();
});

function requireConfiguration() {
  if (!supabaseUrl || !publishableKey || !serviceRoleKey) {
    throw new Error("Supabase is not configured. Copy .env.example to .env and add the CourseWise project keys.");
  }
}

// One helper adds the server-only service key to database and Auth admin calls.
async function supabaseRequest(pathname, options = {}) {
  requireConfiguration();
  const apiKey = options.apiKey || serviceRoleKey;
  const headers = {
    apikey: apiKey,
    Authorization: `Bearer ${options.bearer || apiKey}`,
    Accept: "application/json"
  };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (options.prefer) headers.Prefer = options.prefer;
  const response = await fetch(`${supabaseUrl}${pathname}`, {
    method: options.method || "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const raw = await response.text();
  let data = null;
  if (raw) {
    try { data = JSON.parse(raw); } catch { data = raw; }
  }
  if (!response.ok) {
    const message = data?.message || data?.msg || data?.error_description || data?.details || "Supabase request failed.";
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return data;
}

function encoded(value) {
  return encodeURIComponent(String(value));
}

function requireLogin(req, res, next) {
  if (req.admin) return next();
  if (req.adminCheckError) return renderError(res, req.adminCheckError, "Could not verify admin access");
  clearAdminCookie(res);
  redirectWithNotice(res, "Please sign in with a CourseWise admin account.", "error");
}

function renderError(res, error, title = "Something went wrong") {
  console.error(error);
  res.status(error.status && error.status < 500 ? error.status : 500).render("error", {
    title,
    message: error.message || "The request could not be completed. Check your configuration and try again."
  });
}

// Only users listed in CourseWise's existing admin allow-list can enter this app.
async function isCourseWiseAdmin(authUserId) {
  const rows = await supabaseRequest(
    `/rest/v1/coursewise_admins?select=user_id&user_id=eq.${encoded(authUserId)}&limit=1`
  );
  return Array.isArray(rows) && rows.length > 0;
}

async function getProfileUsers() {
  const profiles = await supabaseRequest(
    "/rest/v1/User?select=UserID,AuthUserID,FirstName,LastName,Username&order=UserID.asc"
  );
  const authResult = await supabaseRequest("/auth/v1/admin/users?page=1&per_page=1000");
  const authUsers = authResult.users || [];
  const authById = new Map(authUsers.map(user => [user.id, user]));
  return profiles.map(profile => ({
    ...profile,
    email: authById.get(profile.AuthUserID)?.email || "(no Auth account found)",
    authUser: authById.get(profile.AuthUserID) || null
  }));
}

async function getProfile(userId) {
  const rows = await supabaseRequest(
    `/rest/v1/User?select=UserID,AuthUserID,FirstName,LastName,Username&UserID=eq.${encoded(userId)}&limit=1`
  );
  if (!rows.length) return null;
  const profile = rows[0];
  const authResult = await supabaseRequest(`/auth/v1/admin/users/${encoded(profile.AuthUserID)}`);
  // Supabase Auth versions may return the user directly or nested under `user`.
  const authUser = authResult.user || authResult.data?.user || authResult;
  return { ...profile, email: authUser.email || "" };
}

async function getTask(taskId) {
  const rows = await supabaseRequest(
    `/rest/v1/Tasks?select=TaskID,UserID,Name,TaskDueDate,IsComplete&TaskID=eq.${encoded(taskId)}&limit=1`
  );
  return rows[0] || null;
}

function dateForInput(value) {
  return value ? String(value).slice(0, 10) : "";
}

function formatDueDate(value) {
  if (!value) return "No due date";
  const date = new Date(`${String(value).slice(0, 10)}T12:00:00`);
  return Number.isNaN(date.getTime()) ? String(value).slice(0, 10) : date.toLocaleDateString();
}

app.get("/", (req, res) => {
  res.render("index", { notice: res.locals.notice });
});

app.post("/login", async (req, res) => {
  try {
    requireConfiguration();
    const userEmail = String(req.body.user_email || "").trim().toLowerCase();
    const userPassword = String(req.body.user_password || "");
    if (!userEmail || !userPassword) {
      return redirectWithNotice(res, "Enter both your email and password.", "error");
    }
    // Supabase Auth verifies the password. The app never stores or logs it.
    const signedIn = await supabaseRequest("/auth/v1/token?grant_type=password", {
      method: "POST",
      apiKey: publishableKey,
      body: { email: userEmail, password: userPassword }
    });
    if (!await isCourseWiseAdmin(signedIn.user.id)) {
      clearAdminCookie(res);
      return redirectWithNotice(res, "This account does not have CourseWise admin access.", "error");
    }
    const admin = { id: signedIn.user.id, email: signedIn.user.email };
    res.cookie(sessionCookie, createAdminCookie(admin), { ...cookieOptions(), maxAge: sessionLifetimeMs });
    redirectWithNotice(res, "You are signed in.");
  } catch (error) {
    // Do not distinguish unknown emails from incorrect passwords on the login page.
    redirectWithNotice(res, error.status === 400 || error.status === 401
      ? "Email or password was not accepted."
      : error.message, "error");
  }
});

app.post("/logout", requireLogin, (req, res) => {
  clearAdminCookie(res);
  redirectWithNotice(res, "You are signed out.");
});

// User CRUD: profile fields live in public."User"; credentials stay in Supabase Auth.
app.get("/users", requireLogin, async (req, res) => {
  try {
    const users = await getProfileUsers();
    res.render("users", { users });
  } catch (error) { renderError(res, error, "Could not load users"); }
});

app.get("/users/new", requireLogin, (req, res) => {
  res.render("user-form", { user: null, formAction: "/users", pageTitle: "Add user", notice: "" });
});

app.post("/users", requireLogin, async (req, res) => {
  let createdAuthId = null;
  try {
    const email = String(req.body.user_email || "").trim().toLowerCase();
    const password = String(req.body.user_password || "");
    const firstName = String(req.body.first_name || "").trim();
    const lastName = String(req.body.last_name || "").trim();
    const username = String(req.body.username || "").trim();
    if (!email || password.length < 8 || !firstName || !lastName || !username) {
      throw new Error("Enter every field. New passwords must be at least 8 characters.");
    }
    const created = await supabaseRequest("/auth/v1/admin/users", {
      method: "POST",
      body: {
        email,
        password,
        email_confirm: true,
        user_metadata: { first_name: firstName, last_name: lastName, username }
      }
    });
    createdAuthId = created.id;
    // Keep the profile table in sync whether or not the project has an Auth trigger.
    const profiles = await supabaseRequest(`/rest/v1/User?select=UserID&AuthUserID=eq.${encoded(createdAuthId)}&limit=1`);
    if (profiles.length) {
      await supabaseRequest(`/rest/v1/User?UserID=eq.${encoded(profiles[0].UserID)}`, {
        method: "PATCH",
        body: { FirstName: firstName, LastName: lastName, Username: username },
        prefer: "return=minimal"
      });
    } else {
      await supabaseRequest("/rest/v1/User", {
        method: "POST",
        body: [{ AuthUserID: createdAuthId, FirstName: firstName, LastName: lastName, Username: username }],
        prefer: "return=minimal"
      });
    }
    redirectWithNotice(res, "User added.");
  } catch (error) {
    // Roll back the Auth account if profile creation failed part way through.
    if (createdAuthId) {
      try { await supabaseRequest(`/auth/v1/admin/users/${encoded(createdAuthId)}`, { method: "DELETE" }); } catch {}
    }
    renderError(res, error, "Could not add user");
  }
});

app.get("/users/:id/edit", requireLogin, async (req, res) => {
  try {
    const user = await getProfile(req.params.id);
    if (!user) return res.status(404).render("error", { title: "User not found", message: "That profile could not be found." });
    res.render("user-form", { user, formAction: `/users/${encoded(user.UserID)}/edit`, pageTitle: "Edit user", notice: "" });
  } catch (error) { renderError(res, error, "Could not load user"); }
});

app.post("/users/:id/edit", requireLogin, async (req, res) => {
  try {
    const user = await getProfile(req.params.id);
    if (!user) return res.status(404).render("error", { title: "User not found", message: "That profile could not be found." });
    const email = String(req.body.user_email || "").trim().toLowerCase();
    const password = String(req.body.user_password || "");
    const firstName = String(req.body.first_name || "").trim();
    const lastName = String(req.body.last_name || "").trim();
    const username = String(req.body.username || "").trim();
    if (!email || !firstName || !lastName || !username) throw new Error("Email, first name, last name, and username are required.");
    if (password && password.length < 8) throw new Error("A new password must be at least 8 characters.");
    const authUpdate = { email, user_metadata: { first_name: firstName, last_name: lastName, username } };
    if (password) authUpdate.password = password;
    await supabaseRequest(`/auth/v1/admin/users/${encoded(user.AuthUserID)}`, { method: "PUT", body: authUpdate });
    await supabaseRequest(`/rest/v1/User?UserID=eq.${encoded(user.UserID)}`, {
      method: "PATCH",
      body: { FirstName: firstName, LastName: lastName, Username: username },
      prefer: "return=minimal"
    });
    redirectWithNotice(res, "User changes saved.");
  } catch (error) { renderError(res, error, "Could not update user"); }
});

app.post("/users/:id/delete", requireLogin, async (req, res) => {
  try {
    const user = await getProfile(req.params.id);
    if (!user) return res.status(404).render("error", { title: "User not found", message: "That profile could not be found." });
    if (user.AuthUserID === req.admin.id) throw new Error("You cannot delete the account you are currently using.");
    // Removing the Auth account first lets existing database foreign keys cascade normally.
    await supabaseRequest(`/auth/v1/admin/users/${encoded(user.AuthUserID)}`, { method: "DELETE" });
    await supabaseRequest(`/rest/v1/User?UserID=eq.${encoded(user.UserID)}`, { method: "DELETE" });
    redirectWithNotice(res, "User deleted.");
  } catch (error) { renderError(res, error, "Could not delete user"); }
});

// Task CRUD: records use the existing public."Tasks" columns and a selected CourseWise owner.
app.get("/tasks", requireLogin, async (req, res) => {
  try {
    const [tasks, users] = await Promise.all([
      supabaseRequest("/rest/v1/Tasks?select=TaskID,UserID,Name,TaskDueDate,IsComplete&order=TaskDueDate.asc.nullslast,TaskID.asc"),
      supabaseRequest("/rest/v1/User?select=UserID,FirstName,LastName,Username&order=FirstName.asc")
    ]);
    const names = new Map(users.map(user => [String(user.UserID), `${user.FirstName || ""} ${user.LastName || ""}`.trim() || user.Username || "CourseWise user"]));
    res.render("tasks", { tasks, names, formatDueDate });
  } catch (error) { renderError(res, error, "Could not load tasks"); }
});

app.get("/tasks/new", requireLogin, async (req, res) => {
  try {
    const users = await supabaseRequest("/rest/v1/User?select=UserID,FirstName,LastName,Username&order=FirstName.asc");
    res.render("task-form", { task: null, users, formAction: "/tasks", pageTitle: "Add task", notice: "", dateForInput });
  } catch (error) { renderError(res, error, "Could not open task form"); }
});

app.post("/tasks", requireLogin, async (req, res) => {
  try {
    const name = String(req.body.name || "").trim();
    const userId = String(req.body.user_id || "");
    const dueDate = String(req.body.due_date || "");
    if (!name || !userId) throw new Error("Enter a task name and choose an owner.");
    const record = {
      Name: name,
      UserID: userId,
      TaskDueDate: dueDate ? `${dueDate}T12:00:00.000Z` : null,
      HasDueTime: false,
      IsComplete: req.body.is_complete === "on",
      IsAssignment: false,
      TaskCreationDate: new Date().toISOString()
    };
    await supabaseRequest("/rest/v1/Tasks", { method: "POST", body: [record], prefer: "return=minimal" });
    redirectWithNotice(res, "Task added.");
  } catch (error) { renderError(res, error, "Could not add task"); }
});

app.get("/tasks/:id/edit", requireLogin, async (req, res) => {
  try {
    const [task, users] = await Promise.all([
      getTask(req.params.id),
      supabaseRequest("/rest/v1/User?select=UserID,FirstName,LastName,Username&order=FirstName.asc")
    ]);
    if (!task) return res.status(404).render("error", { title: "Task not found", message: "That task could not be found." });
    res.render("task-form", { task, users, formAction: `/tasks/${encoded(task.TaskID)}/edit`, pageTitle: "Edit task", notice: "", dateForInput });
  } catch (error) { renderError(res, error, "Could not load task"); }
});

app.post("/tasks/:id/edit", requireLogin, async (req, res) => {
  try {
    const task = await getTask(req.params.id);
    if (!task) return res.status(404).render("error", { title: "Task not found", message: "That task could not be found." });
    const name = String(req.body.name || "").trim();
    const userId = String(req.body.user_id || "");
    const dueDate = String(req.body.due_date || "");
    if (!name || !userId) throw new Error("Enter a task name and choose an owner.");
    await supabaseRequest(`/rest/v1/Tasks?TaskID=eq.${encoded(task.TaskID)}`, {
      method: "PATCH",
      body: {
        Name: name,
        UserID: userId,
        TaskDueDate: dueDate ? `${dueDate}T12:00:00.000Z` : null,
        HasDueTime: false,
        IsComplete: req.body.is_complete === "on"
      },
      prefer: "return=minimal"
    });
    redirectWithNotice(res, "Task changes saved.");
  } catch (error) { renderError(res, error, "Could not update task"); }
});

app.post("/tasks/:id/delete", requireLogin, async (req, res) => {
  try {
    await supabaseRequest(`/rest/v1/Tasks?TaskID=eq.${encoded(req.params.id)}`, { method: "DELETE" });
    redirectWithNotice(res, "Task deleted.");
  } catch (error) { renderError(res, error, "Could not delete task"); }
});

app.use((req, res) => {
  res.status(404).render("error", { title: "Page not found", message: "The page you requested does not exist." });
});

// Local development uses a normal Node server; Vercel invokes the exported Express app.
if (require.main === module) {
  app.listen(port, () => console.log(`CourseWise Admin is listening on port ${port}.`));
}

module.exports = app;
