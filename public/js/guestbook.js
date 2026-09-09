(function () {
  "use strict";

  var form = document.getElementById("guestbook-form");
  var list = document.getElementById("guestbook-list");
  var errorEl = document.getElementById("guestbook-error");
  var submitButton = form ? form.querySelector('button[type="submit"]') : null;
  var isSubmitting = false;
  if (!form || !list) return;

  function escapeHtml(text) {
    var div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }

  var TIME_UNITS = [
    ["year", 31536000],
    ["month", 2592000],
    ["day", 86400],
    ["hour", 3600],
    ["min", 60],
    ["sec", 1],
  ];

  function timeAgo(unixSeconds) {
    var diff = Math.floor(Date.now() / 1000) - unixSeconds;
    if (diff < 5) return "just now";
    for (var i = 0; i < TIME_UNITS.length; i++) {
      var unit = TIME_UNITS[i][0];
      var seconds = TIME_UNITS[i][1];
      var value = Math.floor(diff / seconds);
      if (value >= 1) {
        return value + " " + unit + (value === 1 ? "" : "s") + " ago";
      }
    }
    return "just now";
  }

  function renderMessage(msg, prepend) {
    var li = document.createElement("li");
    li.className = "guestbook-message";

    var nameHtml = msg.url
      ? '<a href="' + escapeHtml(msg.url) + '" target="_blank" rel="nofollow noopener noreferrer">' + escapeHtml(msg.name) + "</a>"
      : escapeHtml(msg.name);
    var header = document.createElement("div");
    header.className = "guestbook-message-header";
    header.innerHTML = '<span class="guestbook-message-name">' + nameHtml + "</span>" +
      '<span class="guestbook-message-date">' + escapeHtml(timeAgo(msg.created_at)) + "</span>";

    var body = document.createElement("div");
    body.className = "guestbook-message-body";
    body.textContent = msg.message;

    li.appendChild(header);
    li.appendChild(body);

    if (prepend) {
      list.insertBefore(li, list.firstChild);
    } else {
      list.appendChild(li);
    }
  }

  function showError(text) {
    errorEl.textContent = text;
    errorEl.hidden = false;
  }

  function clearError() {
    errorEl.hidden = true;
    errorEl.textContent = "";
  }

  fetch("/api/messages")
    .then(function (res) { return res.json(); })
    .then(function (messages) {
      messages.forEach(function (msg) { renderMessage(msg, false); });
    });

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    if (isSubmitting) return;
    isSubmitting = true;
    if (submitButton) submitButton.disabled = true;
    clearError();

    var turnstileToken = "";
    var widget = form.querySelector(".cf-turnstile textarea, .cf-turnstile input[name='cf-turnstile-response']");
    if (widget) turnstileToken = widget.value;

    var payload = {
      name: form.elements.name.value,
      url: form.elements.url.value,
      message: form.elements.message.value,
      turnstileToken: turnstileToken,
    };

    fetch("/api/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
      .then(function (res) {
        return res.json().then(function (body) { return { ok: res.ok, body: body }; });
      })
      .then(function (result) {
        if (!result.ok) {
          showError(result.body.error || "Something went wrong.");
          return;
        }
        renderMessage(result.body, true);
        form.reset();
        if (window.turnstile) window.turnstile.reset();
      })
      .catch(function () {
        showError("Network error. Please try again.");
      })
      .then(function () {
        isSubmitting = false;
        if (submitButton) submitButton.disabled = false;
      });
  });
})();
