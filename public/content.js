/* LUKEV website: shows the service text and photos the owner changed in /admin.
 * If nothing was changed (or the server cannot be reached) the text and photos already in the page stay.
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

  // The three galleries. A gallery with no uploaded photos keeps the built-in photos.
  var GALLERIES = {
    ndt:       { target: "ndtGallery",       label: "NDT / FIELD INSPECTION" },
    equipment: { target: "equipmentGallery", label: "EQUIPMENT / FIELD READY" },
    solar:     { target: "solarGallery",     label: "SOLAR / ENERGY SYSTEMS" }
  };

  function photoCard(photo, index, label) {
    var alt = photo.caption || "LUKEV project photo";
    var card = document.createElement("button");
    card.type = "button";
    card.className = "img-card group relative overflow-hidden rounded-2xl border border-white/10 bg-zinc-900 text-left " +
      (index === 0 ? "col-span-2 aspect-[16/8]" : "aspect-[4/3]");
    card.setAttribute("aria-label", "Open image: " + alt);

    var img = document.createElement("img");
    img.src = photo.url;
    img.alt = alt;
    img.loading = index === 0 ? "eager" : "lazy";
    img.decoding = "async";
    img.className = "h-full w-full object-cover";

    var tag = document.createElement("span");
    tag.className = "absolute inset-x-3 bottom-3 rounded-lg border border-white/10 bg-black/45 px-3 py-2 font-mono text-[9px] uppercase tracking-[.14em] text-zinc-200 backdrop-blur-md";
    tag.textContent = photo.caption || label;

    card.append(img, tag);
    card.addEventListener("click", function () {
      if (typeof window.openLightbox === "function") window.openLightbox({ url: photo.url, alt: alt });
    });
    return card;
  }

  function applyPhotos(photos) {
    if (!Array.isArray(photos)) return;
    Object.keys(GALLERIES).forEach(function (id) {
      var where = GALLERIES[id];
      var mine = photos.filter(function (p) {
        return p && p.gallery === id && typeof p.url === "string" && p.url.indexOf("/media/photos/") === 0;
      });
      var target = document.getElementById(where.target);
      if (!target || !mine.length) return;
      target.replaceChildren.apply(target, mine.map(function (p, i) { return photoCard(p, i, where.label); }));
    });
  }

  fetch("/api/content", { headers: { Accept: "application/json" } })
    .then(function (res) { return res.json(); })
    .then(function (data) {
      if (!data || data.ok !== true) return;
      data.services = data.services || {};
      Object.keys(SERVICES).forEach(function (id) { apply(id, data.services[id]); });
      applyPhotos(data.photos);
    })
    .catch(function () { /* keep the built-in text */ });
})();
