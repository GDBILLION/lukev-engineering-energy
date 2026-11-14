/* LUKEV website: shows the service text the owner edited in /admin.
 * If nothing was edited (or the server cannot be reached) the text already in the page stays.
 * Text is always set with textContent, never innerHTML, so saved text can never run code. */
(function () {
  "use strict";

  // Where each service lives in the page. "card" is its position among the three cards under #services.
  var SERVICES = {
    ndt:       { card: 0, section: "#ndt",       list: "#ndt ul",                    itemTag: "li" },
    equipment: { card: 1, section: "#equipment", list: "#equipment .reveal > div.grid", itemTag: "span" },
    solar:     { card: 2, section: "#solar",     list: "#solar ul",                  itemTag: "li" }
  };

  function setText(parent, selector, value) {
    var node = parent && parent.querySelector(selector);
    if (node && typeof value === "string" && value) node.textContent = value;
  }

  function apply(id, data) {
    var where = SERVICES[id];
    if (!where || !data) return;

    var cards = document.querySelectorAll("#services article");
    var card = cards[where.card];
    setText(card, "h3", data.title);
    setText(card, "p", data.summary);

    var section = document.querySelector(where.section);
    setText(section, "h2", data.heading);
    setText(section, "p.leading-8", data.intro);

    var list = document.querySelector(where.list);
    if (list && Array.isArray(data.bullets) && data.bullets.length) {
      var nodes = data.bullets.map(function (text) {
        var item = document.createElement(where.itemTag);
        item.textContent = String(text);
        return item;
      });
      list.replaceChildren.apply(list, nodes);
    }
  }

  fetch("/api/content", { headers: { Accept: "application/json" } })
    .then(function (res) { return res.json(); })
    .then(function (data) {
      if (!data || data.ok !== true || !data.services) return;
      Object.keys(SERVICES).forEach(function (id) { apply(id, data.services[id]); });
    })
    .catch(function () { /* keep the built-in text */ });
})();
