/* LUKEV admin: sign in with Cognito, then read, handle and delete website enquiries.
 * Everything from the database is shown with textContent (never innerHTML), so a visitor's
 * message can never run code in the owner's browser. */
(function () {
  "use strict";

  var SESSION_KEY = "lukev_admin_session";
  var cfg = null; // { region, clientId } from /api/auth-config
  var session = null; // { idToken, refreshToken, expiresAt, email }
  var pending = null; // first-login challenge: { session, email }
  var items = [];
  var filter = "new";

  // ---------- small helpers ----------
  function $(id) { return document.getElementById(id); }

  function el(tag, attrs) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (key) {
      var value = attrs[key];
      if (key === "class") node.className = value;
      else if (key === "text") node.textContent = value;
      else if (key.slice(0, 2) === "on") node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value);
    });
    for (var i = 2; i < arguments.length; i++) {
      if (arguments[i]) node.append(arguments[i]);
    }
    return node;
  }

  function show(view) {
    ["view-login", "view-newpass", "view-inbox"].forEach(function (id) { $(id).hidden = id !== view; });
  }

  function saveSession() {
    try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(session)); } catch (e) { /* private mode: stay in memory */ }
  }

  function loadSession() {
    try { return JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null"); } catch (e) { return null; }
  }

  function clearSession() {
    session = null;
    try { sessionStorage.removeItem(SESSION_KEY); } catch (e) { /* ignore */ }
  }

  function emailFromToken(token) {
    try {
      var part = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
      return JSON.parse(atob(part)).email || "";
    } catch (e) { return ""; }
  }

  // ---------- Cognito (direct calls, no SDK) ----------
  function cognito(target, body) {
    return fetch("https://cognito-idp." + cfg.region + ".amazonaws.com/", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-amz-json-1.1",
        "X-Amz-Target": "AWSCognitoIdentityProviderService." + target,
      },
      body: JSON.stringify(body),
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) {
          var err = new Error(data.message || "Request failed.");
          err.code = String(data.__type || "").split("#").pop();
          throw err;
        }
        return data;
      });
    });
  }

  function friendlyAuthError(err) {
    switch (err && err.code) {
      case "NotAuthorizedException":
      case "UserNotFoundException":
        return "Incorrect email or password.";
      case "InvalidPasswordException":
      case "InvalidParameterException":
        return err.message;
      case "PasswordResetRequiredException":
        return "Your password must be reset. Please contact your developer.";
      case "TooManyRequestsException":
      case "LimitExceededException":
        return "Too many attempts. Wait a few minutes and try again.";
      default:
        return err && err.code ? "Could not sign in. Please try again." : "Cannot reach the server. Check your connection.";
    }
  }

  function startSession(result, email, keepRefreshToken) {
    session = {
      idToken: result.IdToken,
      refreshToken: result.RefreshToken || keepRefreshToken,
      expiresAt: Date.now() + (result.ExpiresIn || 3600) * 1000,
      email: email || emailFromToken(result.IdToken),
    };
    saveSession();
  }

  function refreshSession() {
    if (!session || !session.refreshToken) return Promise.resolve(false);
    return cognito("InitiateAuth", {
      AuthFlow: "REFRESH_TOKEN_AUTH",
      ClientId: cfg.clientId,
      AuthParameters: { REFRESH_TOKEN: session.refreshToken },
    }).then(function (data) {
      startSession(data.AuthenticationResult, session.email, session.refreshToken);
      return true;
    }).catch(function () { return false; });
  }

  function signOut(message) {
    clearSession();
    pending = null;
    items = [];
    $("login-password").value = "";
    $("login-error").textContent = message || "";
    show("view-login");
  }

  // ---------- API calls ----------
  function api(path, options, retried) {
    var fresh = session && session.expiresAt - Date.now() > 60000 ? Promise.resolve(true) : refreshSession();
    return fresh.then(function (ok) {
      if (!ok) { signOut("Your session ended. Please sign in again."); throw new Error("signed out"); }
      var opts = options || {};
      return fetch(path, {
        method: opts.method || "GET",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + session.idToken },
        body: opts.body,
      });
    }).then(function (res) {
      if (res.status === 401 && !retried) {
        return refreshSession().then(function (ok) {
          if (!ok) { signOut("Your session ended. Please sign in again."); throw new Error("signed out"); }
          return api(path, options, true);
        });
      }
      return res.json().catch(function () { return null; }).then(function (data) {
        if (!res.ok || !data || data.ok !== true) throw new Error((data && data.error) || "Something went wrong. Please try again.");
        return data;
      });
    });
  }

  // ---------- enquiries screen ----------
  function say(message, bad) {
    var node = $("inbox-status");
    node.textContent = message || "";
    node.className = "status" + (bad ? " bad" : "");
  }

  function counts() {
    var n = items.filter(function (i) { return i.status === "new"; }).length;
    return { new: n, handled: items.length - n, all: items.length };
  }

  function visible() {
    return items.filter(function (i) { return filter === "all" || i.status === filter; });
  }

  function render() {
    var c = counts();
    document.querySelectorAll("[data-count]").forEach(function (node) { node.textContent = "(" + c[node.getAttribute("data-count")] + ")"; });
    document.querySelectorAll(".tab").forEach(function (tab) { tab.setAttribute("aria-selected", String(tab.getAttribute("data-filter") === filter)); });

    var list = $("list");
    list.replaceChildren();
    var rows = visible();
    rows.forEach(function (item) { list.append(card(item)); });

    var empty = $("empty");
    empty.hidden = rows.length > 0;
    empty.textContent = filter === "new" ? "No new enquiries. You are all caught up." : "Nothing to show here yet.";
  }

  function card(item) {
    var when = item.createdAt ? new Date(item.createdAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "";
    var handled = item.status === "handled";
    var subject = "Re: your enquiry to LUKEV Engineering" + (item.service ? " (" + item.service + ")" : "");

    return el("article", { class: "item" + (handled ? " handled" : "") },
      el("div", { class: "item-head" },
        el("h2", { class: "item-name", text: item.name || "(no name)" }),
        el("span", { class: "item-date", text: when })
      ),
      el("div", { class: "chips" },
        el("span", { class: "chip", text: item.service || "No service chosen" }),
        el("span", { class: "chip" + (handled ? " handled" : ""), text: handled ? "Handled" : "New" })
      ),
      el("p", { class: "item-line" }, "Email: ", el("a", { href: "mailto:" + item.email, text: item.email })),
      item.company ? el("p", { class: "item-line", text: "Company: " + item.company }) : null,
      item.details ? el("div", { class: "details", text: item.details }) : null,
      el("p", { class: "ref", text: "Reference " + item.id }),
      el("div", { class: "actions" },
        el("button", { class: "btn", type: "button", text: handled ? "Reopen" : "Mark handled", onclick: function () { setStatus(item, handled ? "new" : "handled"); } }),
        el("a", { class: "btn", href: "mailto:" + item.email + "?subject=" + encodeURIComponent(subject), text: "Reply" }),
        el("button", { class: "btn danger", type: "button", text: "Delete", onclick: function () { remove(item); } })
      )
    );
  }

  function load() {
    say("Loading...");
    return api("/api/admin/inquiries?status=all").then(function (data) {
      items = data.items || [];
      say("");
      render();
    }).catch(function (err) {
      if (err.message !== "signed out") say(err.message, true);
    });
  }

  function setStatus(item, status) {
    say("Saving...");
    api("/api/admin/inquiries/" + encodeURIComponent(item.id), { method: "PATCH", body: JSON.stringify({ status: status }) })
      .then(function () {
        item.status = status;
        say(status === "handled" ? "Marked as handled." : "Moved back to new.");
        render();
      })
      .catch(function (err) { if (err.message !== "signed out") say(err.message, true); });
  }

  function remove(item) {
    if (!window.confirm("Delete the enquiry from " + (item.name || "this person") + "? This cannot be undone.")) return;
    say("Deleting...");
    api("/api/admin/inquiries/" + encodeURIComponent(item.id), { method: "DELETE" })
      .then(function () {
        items = items.filter(function (i) { return i.id !== item.id; });
        say("Enquiry deleted.");
        render();
      })
      .catch(function (err) { if (err.message !== "signed out") say(err.message, true); });
  }

  function openInbox() {
    $("who").textContent = session.email || "";
    show("view-inbox");
    return load();
  }

  // ---------- forms ----------
  function busy(button, isBusy, label) {
    button.disabled = isBusy;
    if (label) button.textContent = isBusy ? "Please wait..." : label;
  }

  $("login-form").addEventListener("submit", function (event) {
    event.preventDefault();
    var email = $("login-email").value.trim();
    var password = $("login-password").value;
    var error = $("login-error");
    var button = $("login-submit");
    error.textContent = "";
    if (!email || !password) { error.textContent = "Enter your email and password."; return; }

    busy(button, true, "Sign in");
    cognito("InitiateAuth", {
      AuthFlow: "USER_PASSWORD_AUTH",
      ClientId: cfg.clientId,
      AuthParameters: { USERNAME: email, PASSWORD: password },
    }).then(function (data) {
      if (data.AuthenticationResult) {
        startSession(data.AuthenticationResult, email);
        $("login-password").value = "";
        return openInbox();
      }
      if (data.ChallengeName === "NEW_PASSWORD_REQUIRED") {
        pending = { session: data.Session, email: email };
        $("login-password").value = "";
        show("view-newpass");
        return null;
      }
      error.textContent = "This sign-in step is not supported. Please contact your developer.";
      return null;
    }).catch(function (err) {
      error.textContent = friendlyAuthError(err);
    }).then(function () { busy(button, false, "Sign in"); });
  });

  $("newpass-form").addEventListener("submit", function (event) {
    event.preventDefault();
    var one = $("newpass-1").value;
    var two = $("newpass-2").value;
    var error = $("newpass-error");
    var button = $("newpass-submit");
    error.textContent = "";
    if (one !== two) { error.textContent = "The two passwords do not match."; return; }
    if (one.length < 12) { error.textContent = "Use at least 12 characters."; return; }

    busy(button, true, "Save password and continue");
    cognito("RespondToAuthChallenge", {
      ChallengeName: "NEW_PASSWORD_REQUIRED",
      ClientId: cfg.clientId,
      Session: pending.session,
      ChallengeResponses: { USERNAME: pending.email, NEW_PASSWORD: one },
    }).then(function (data) {
      if (!data.AuthenticationResult) throw new Error("Unexpected response.");
      startSession(data.AuthenticationResult, pending.email);
      pending = null;
      $("newpass-1").value = "";
      $("newpass-2").value = "";
      return openInbox();
    }).catch(function (err) {
      error.textContent = err && err.code ? friendlyAuthError(err) : "Could not save the password. Please try again.";
    }).then(function () { busy(button, false, "Save password and continue"); });
  });

  $("refresh").addEventListener("click", function () { load(); });
  $("signout").addEventListener("click", function () { signOut(""); });
  document.querySelectorAll(".tab").forEach(function (tab) {
    tab.addEventListener("click", function () { filter = tab.getAttribute("data-filter"); render(); });
  });

  // ---------- start ----------
  show("view-login"); // never show a blank page while settings load
  fetch("/api/auth-config")
    .then(function (res) { return res.json(); })
    .then(function (data) {
      if (!data || data.ok !== true || !data.clientId) throw new Error("bad config");
      cfg = { region: data.region, clientId: data.clientId };
      var saved = loadSession();
      if (saved && saved.refreshToken) {
        session = saved;
        return openInbox();
      }
      return null;
    })
    .catch(function () {
      $("login-error").textContent = "Could not load the sign-in settings. Please refresh the page.";
      $("login-submit").disabled = true;
    });
})();
