document.querySelector("#ask").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector("button");
  const status = document.querySelector("#status");
  const message = new FormData(event.currentTarget).get("message");
  const body = JSON.stringify({ message, idempotency_key: crypto.randomUUID() });
  button.classList.add("is-busy");
  button.disabled = true;
  status.className = "status";
  status.textContent = "Искра работает над ответом…";
  try {
    const send = () =>
      fetch("run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
    let response;
    try {
      response = await send();
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      response = await send();
    }
    const result = await response.json();
    document.querySelector("#result").textContent = JSON.stringify(result, null, 2);
    status.className = response.ok ? "status status--ok" : "status status--error";
    status.textContent = response.ok ? "Готово" : "Искра ответила отказом";
  } catch (error) {
    status.className = "status status--error";
    status.textContent = "Не удалось получить ответ: " + error;
  } finally {
    button.classList.remove("is-busy");
    button.disabled = false;
  }
});
