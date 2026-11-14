/* LUKEV admin: sign in with Cognito, then manage enquiries, edit the service text and upload gallery photos.
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
  var page = "inbox"; // "inbox" | "services" | "photos"
  var photos = []; // uploaded photos from the server, in display order
  var MAX_PHOTOS = 12;
  var stored = {}; // edited service text from the server, by service id

  // The text built into the website. Shown in the editor until the owner saves a change.
  var DEFAULTS = {
    ndt: {
      label: "NDT",
      title: "Non-Destructive Testing",
      summary: "Professional inspection services supporting safety, reliability and asset integrity across oil & gas, marine, construction, energy and industrial sectors.",
      heading: "Inspection without compromising the asset.",
      intro: "LUKEV provides professional NDT and inspection services for welds, pipelines, pressure vessels, storage tanks, structures and other critical components, using proven techniques and procedures in line with applicable standards and client requirements.",
      bullets: ["Visual Testing (VT)", "Ultrasonic Testing (UT)", "Magnetic Particle Testing (MT)", "Liquid Penetrant Testing (PT)", "Phased Array Ultrasonic Testing (PAUT)", "Thickness Measurement & Corrosion Monitoring", "Weld Inspection & Evaluation", "In-Service Inspection", "Inspection Reporting & Documentation"]
    },
    equipment: {
      label: "Equipment Leasing",
      title: "Equipment Leasing",
      summary: "Flexible NDT equipment leasing and rental solutions for contractors, inspection companies, maintenance teams and project operators.",
      heading: "Field-ready equipment, without unnecessary capital spend.",
      intro: "Rental and leasing solutions for short-term projects, shutdowns, maintenance campaigns, offshore operations and long-term inspection programs.",
      bullets: ["Ultrasonic flaw detectors", "Ultrasonic thickness gauges", "PAUT equipment & scanners", "Magnetic particle equipment", "Dye penetrant accessories", "UV inspection lamps", "Probes & transducers", "Cables, wedges & scanners"]
    },
    solar: {
      label: "Solar Energy",
      title: "Solar Energy",
      summary: "Solar systems, equipment, installation, commissioning and maintenance/support for residential, commercial and infrastructure needs.",
      heading: "Energy infrastructure designed for the work ahead.",
      intro: "Solar energy installation, equipment and systems \u2014 from design through installation, commissioning and maintenance/support.",
      bullets: ["Solar panels & equipment", "Inverters & battery storage", "System design", "Installation & commissioning", "Maintenance & support", "Commercial and residential systems"]
    }
  };
  var SERVICE_ORDER = ["ndt", "equipment", "solar"];

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
    stored = {};
    photos = [];
    page = "inbox";
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

  // ---------- services screen ----------
  function sayServices(message, bad) {
    var node = $("services-status");
    node.textContent = message || "";
    node.className = "status" + (bad ? " bad" : "");
  }

  function field(id, name, label, value, rows, hint) {
    var control = rows
      ? el("textarea", { id: id + "-" + name, rows: String(rows) })
      : el("input", { id: id + "-" + name, type: "text" });
    control.value = value;
    return [
      el("label", { for: id + "-" + name, text: label }),
      hint ? el("p", { class: "hint", text: hint }) : null,
      control
    ];
  }

  function serviceCard(id) {
    var base = DEFAULTS[id];
    var saved = stored[id];
    var data = saved || base;
    var note = el("p", { class: "note", role: "status" });

    var kids = [
      el("div", { class: "item-head" },
        el("h2", { text: base.label }),
        el("span", { class: "chip" + (saved ? " handled" : ""), text: saved ? "Edited" : "Original text" })
      )
    ];
    field(id, "title", "Name (on the service card)", data.title, 0).forEach(function (n) { kids.push(n); });
    field(id, "summary", "Short description (on the service card)", data.summary, 3).forEach(function (n) { kids.push(n); });
    field(id, "heading", "Headline (on the service section)", data.heading, 0).forEach(function (n) { kids.push(n); });
    field(id, "intro", "Paragraph (on the service section)", data.intro, 5).forEach(function (n) { kids.push(n); });
    field(id, "bullets", "List items", data.bullets.join("\n"), 9, "One item per line. Blank lines are ignored.").forEach(function (n) { kids.push(n); });

    var saveBtn = el("button", { class: "btn save", type: "button", text: "Save changes" });
    var resetBtn = el("button", { class: "btn", type: "button", text: "Reset to original text" });
    saveBtn.addEventListener("click", function () { saveService(id, saveBtn, note); });
    resetBtn.addEventListener("click", function () { resetService(id, note); });
    kids.push(el("div", { class: "actions" }, saveBtn, resetBtn, note));

    return el.apply(null, ["article", { class: "item svc" }].concat(kids));
  }

  function renderServices() {
    var list = $("services-list");
    list.replaceChildren();
    SERVICE_ORDER.forEach(function (id) { list.append(serviceCard(id)); });
  }

  function loadServices() {
    sayServices("Loading...");
    return api("/api/admin/content").then(function (data) {
      stored = data.services || {};
      sayServices("");
      renderServices();
    }).catch(function (err) {
      if (err.message !== "signed out") sayServices(err.message, true);
    });
  }

  function readService(id) {
    function value(name) { return $(id + "-" + name).value; }
    return {
      title: value("title"),
      summary: value("summary"),
      heading: value("heading"),
      intro: value("intro"),
      bullets: value("bullets").split("\n")
    };
  }

  function saveService(id, button, note) {
    note.textContent = "";
    note.className = "note";
    button.disabled = true;
    api("/api/admin/services/" + id, { method: "PUT", body: JSON.stringify(readService(id)) })
      .then(function () { return loadServices(); })
      .then(function () { sayServices(DEFAULTS[id].label + " saved. It is now live on the website."); })
      .catch(function (err) {
        button.disabled = false;
        if (err.message === "signed out") return;
        note.textContent = err.message;
        note.className = "note bad";
      });
  }

  function resetService(id, note) {
    if (!window.confirm("Put back the original " + DEFAULTS[id].label + " text? Your edits will be lost.")) return;
    api("/api/admin/services/" + id, { method: "DELETE" })
      .then(function () { return loadServices(); })
      .then(function () { sayServices(DEFAULTS[id].label + " is back to its original text."); })
      .catch(function (err) {
        if (err.message === "signed out") return;
        note.textContent = err.message;
        note.className = "note bad";
      });
  }

  // ---------- photos screen ----------
  function sayPhotos(message, bad) {
    var node = $("photos-status");
    node.textContent = message || "";
    node.className = "status" + (bad ? " bad" : "");
  }

  function decodeImage(file) {
    function viaImage() {
      return new Promise(function (resolve, reject) {
        var reader = new FileReader();
        reader.onerror = function () { reject(new Error("Could not read that file.")); };
        reader.onload = function () {
          var img = new Image();
          img.onload = function () { resolve(img); };
          img.onerror = function () { reject(new Error("That file is not a photo this browser can open. Try a JPEG or PNG.")); };
          img.src = reader.result;
        };
        reader.readAsDataURL(file);
      });
    }
    if (window.createImageBitmap) {
      return createImageBitmap(file, { imageOrientation: "from-image" }).catch(viaImage);
    }
    return viaImage();
  }

  // Shrinks the photo to at most 1800 pixels and re-saves it as a JPEG (this also removes hidden
  // data such as the GPS location). Returns the JPEG as base64 text.
  function prepareJpeg(file) {
    return decodeImage(file).then(function (img) {
      var width = img.naturalWidth || img.width;
      var height = img.naturalHeight || img.height;
      var scale = Math.min(1, 1800 / Math.max(width, height));
      var canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      var ctx = canvas.getContext("2d");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      if (img.close) img.close();
      var qualities = [0.85, 0.7, 0.55];
      for (var i = 0; i < qualities.length; i++) {
        var data = canvas.toDataURL("image/jpeg", qualities[i]).split(",")[1] || "";
        if (data.length < 3900000) return data;
      }
      throw new Error("That photo is too large even after shrinking it.");
    });
  }

  function loadPhotos() {
    sayPhotos("Loading...");
    return api("/api/admin/content").then(function (data) {
      photos = data.photos || [];
      sayPhotos("");
      renderPhotos();
    }).catch(function (err) {
      if (err.message !== "signed out") sayPhotos(err.message, true);
    });
  }

  function photoTile(photo, isFirst) {
    var caption = el("input", { type: "text", maxlength: "100", placeholder: "Caption (optional)", "aria-label": "Caption" });
    caption.value = photo.caption || "";
    var note = el("p", { class: "note", role: "status" });

    var save = el("button", { class: "btn", type: "button", text: "Save caption" });
    save.addEventListener("click", function () { changePhoto(photo, { caption: caption.value }, "Caption saved.", note); });
    var front = el("button", { class: "btn", type: "button", text: "Make first" });
    front.addEventListener("click", function () { changePhoto(photo, { first: true }, "Moved to the front.", note, true); });
    var del = el("button", { class: "btn danger", type: "button", text: "Delete" });
    del.addEventListener("click", function () { deletePhoto(photo, note); });

    return el("div", { class: "photo" },
      el("img", { src: photo.url, alt: photo.caption || "Uploaded photo", loading: "lazy" }),
      isFirst ? el("span", { class: "badge", text: "Shown large" }) : null,
      caption,
      el("div", { class: "row" }, save, isFirst ? null : front, del),
      note
    );
  }

  function uploadBox(id, count) {
    var caption = el("input", { id: id + "-newcaption", type: "text", maxlength: "100", placeholder: "Caption for the new photos (optional)" });
    var file = el("input", { id: id + "-file", type: "file", accept: "image/*", multiple: "multiple" });
    var note = el("p", { class: "note", role: "status" });
    if (count >= MAX_PHOTOS) file.disabled = true;

    file.addEventListener("change", function () {
      var list = Array.prototype.slice.call(file.files || []);
      if (!list.length) return;
      uploadFiles(id, list, caption.value, note).then(function () { file.value = ""; });
    });

    return el("div", { class: "upload" },
      el("label", { for: id + "-file", text: count >= MAX_PHOTOS ? "This gallery is full. Delete a photo to add another." : "Add photos" }),
      caption,
      el("div", { class: "gap" }),
      file,
      note
    );
  }

  function renderPhotos() {
    var list = $("photos-list");
    list.replaceChildren();
    SERVICE_ORDER.forEach(function (id) {
      var mine = photos.filter(function (p) { return p.gallery === id; });
      var grid = el("div", { class: "photos" });
      mine.forEach(function (p, i) { grid.append(photoTile(p, i === 0)); });
      list.append(el("article", { class: "item svc" },
        el("div", { class: "item-head" },
          el("h2", { text: DEFAULTS[id].label }),
          el("span", { class: "chip", text: mine.length ? mine.length + " of " + MAX_PHOTOS + " photos" : "Stock photos" })
        ),
        mine.length ? grid : el("p", { class: "muted", text: "No photos of yours yet. The website shows its stock photos here." }),
        uploadBox(id, mine.length)
      ));
    });
  }

  function uploadFiles(gallery, files, caption, note) {
    var done = 0;
    var failed = 0;
    note.className = "note";
    // One at a time, so a slow phone connection is not overloaded.
    return files.reduce(function (chain, file, index) {
      return chain.then(function () {
        note.textContent = "Uploading " + (index + 1) + " of " + files.length + "...";
        return prepareJpeg(file)
          .then(function (data) {
            return api("/api/admin/photos", { method: "POST", body: JSON.stringify({ gallery: gallery, caption: caption, data: data }) });
          })
          .then(function () { done++; })
          .catch(function (err) {
            if (err.message === "signed out") throw err;
            failed++;
            note.className = "note bad";
            note.textContent = file.name + ": " + err.message;
          });
      });
    }, Promise.resolve()).then(function () {
      return loadPhotos();
    }).then(function () {
      sayPhotos(done + (done === 1 ? " photo" : " photos") + " uploaded" + (failed ? ", " + failed + " failed." : ". They are now live on the website."), failed > 0 && done === 0);
    }).catch(function () { /* signed out */ });
  }

  function changePhoto(photo, body, okMessage, note, reload) {
    note.textContent = "";
    note.className = "note";
    api("/api/admin/photos/" + encodeURIComponent(photo.id), { method: "PATCH", body: JSON.stringify(body) })
      .then(function () {
        if (reload) return loadPhotos().then(function () { sayPhotos(okMessage); });
        photo.caption = body.caption !== undefined ? body.caption.trim() : photo.caption;
        note.textContent = okMessage;
        return null;
      })
      .catch(function (err) {
        if (err.message === "signed out") return;
        note.textContent = err.message;
        note.className = "note bad";
      });
  }

  function deletePhoto(photo, note) {
    if (!window.confirm("Delete this photo? It disappears from the website. This cannot be undone.")) return;
    api("/api/admin/photos/" + encodeURIComponent(photo.id), { method: "DELETE" })
      .then(function () { return loadPhotos(); })
      .then(function () { sayPhotos("Photo deleted."); })
      .catch(function (err) {
        if (err.message === "signed out") return;
        note.textContent = err.message;
        note.className = "note bad";
      });
  }

  // ---------- pages ----------
  function setPage(name) {
    page = name;
    $("page-inbox").hidden = name !== "inbox";
    $("page-services").hidden = name !== "services";
    $("page-photos").hidden = name !== "photos";
    $("page-title").textContent = name === "inbox" ? "Enquiries" : name === "services" ? "Services" : "Photos";
    document.querySelectorAll(".navtab").forEach(function (tab) {
      if (tab.getAttribute("data-page") === name) tab.setAttribute("aria-current", "page");
      else tab.removeAttribute("aria-current");
    });
    return name === "inbox" ? load() : name === "services" ? loadServices() : loadPhotos();
  }

  function openInbox() {
    $("who").textContent = session.email || "";
    show("view-inbox");
    return setPage("inbox");
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

  $("refresh").addEventListener("click", function () { setPage(page); });
  document.querySelectorAll(".navtab").forEach(function (tab) {
    tab.addEventListener("click", function () { setPage(tab.getAttribute("data-page")); });
  });
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
