(function () {
  "use strict";

  var form = document.getElementById("guestbook-form");
  var list = document.getElementById("guestbook-list");
  var errorEl = document.getElementById("guestbook-error");
  if (!form || !list) return;

  function escapeHtml(text) {
    var div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }

  function formatDate(unixSeconds) {
    var d = new Date(unixSeconds * 1000);
    var pad = function (n) { return n < 10 ? "0" + n : "" + n; };
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }

  function renderMessage(msg, prepend) {
    var li = document.createElement("li");
    li.className = "guestbook-message";

    var nameHtml = msg.url
      ? '<a href="' + escapeHtml(msg.url) + '" target="_blank" rel="nofollow noopener noreferrer">' + escapeHtml(msg.name) + "</a>"
      : escapeHtml(msg.name);
    var body = document.createElement("div");
    body.innerHTML = "<strong>" + nameHtml + ":</strong> " + escapeHtml(msg.message);

    var date = document.createElement("span");
    date.className = "guestbook-message-date";
    date.textContent = formatDate(msg.created_at);

    li.appendChild(body);
    li.appendChild(date);

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
      });
  });
})();
