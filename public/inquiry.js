/* Sends the contact form (#inquiryForm) to POST /api/inquiries.
 * Loaded from public/original.html with:  <script src="/inquiry.js" defer></script>
 * It takes over the form's submit event, so the old placeholder handler no longer runs. */
(function () {
  "use strict";

  var form = document.getElementById("inquiryForm");
  if (!form) return;

  var FALLBACK = "Something went wrong. Please try again or email info@lukevengineering.com.";
  var startedAt = Date.now();

  // Hidden field that real visitors never see or fill. Bots that fill every field give themselves away.
  var trap = document.createElement("input");
  trap.type = "text";
  trap.name = "website";
  trap.tabIndex = -1;
  trap.autocomplete = "off";
  trap.setAttribute("aria-hidden", "true");
  trap.style.cssText = "position:absolute;left:-9999px;width:1px;height:1px;opacity:0;";
  form.appendChild(trap);

  // Message area under the form (screen readers announce it).
  var status = document.createElement("p");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.style.cssText = "margin-top:12px;font-weight:600;";
  form.appendChild(status);

  var button = form.querySelector('button[type="submit"], input[type="submit"], button:not([type])');

  function value(fieldName) {
    var el = form.elements[fieldName];
    return el && typeof el.value === "string" ? el.value.trim() : "";
  }

  function show(message, ok) {
    status.textContent = message;
    status.style.color = ok ? "#22c55e" : "#ef4444";
  }

  function busy(isBusy) {
    if (!button) return;
    button.disabled = isBusy;
    button.style.opacity = isBusy ? "0.6" : "";
  }

  // Capture phase + stopImmediatePropagation: our handler runs first and the old one never does.
  form.addEventListener(
    "submit",
    function (event) {
      event.preventDefault();
      event.stopImmediatePropagation();

      var payload = {
        name: value("name"),
        email: value("email"),
        company: value("company"),
        service: value("service"),
        details: value("details"),
        website: trap.value,
        elapsedMs: Date.now() - startedAt,
      };

      busy(true);
      show("Sending...", true);

      var controller = new AbortController();
      var timer = setTimeout(function () {
        controller.abort();
      }, 15000);

      fetch("/api/inquiries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      })
        .then(function (response) {
          return response.json().catch(function () {
            return null;
          });
        })
        .then(function (data) {
          if (data && data.ok === true) {
            show("Thank you. Your enquiry has been received and we will reply to you shortly.", true);
            form.reset();
            startedAt = Date.now();
          } else {
            show(data && typeof data.error === "string" ? data.error : FALLBACK, false);
          }
        })
        .catch(function () {
          show(FALLBACK, false);
        })
        .then(function () {
          clearTimeout(timer);
          busy(false);
        });
    },
    true
  );
})();
