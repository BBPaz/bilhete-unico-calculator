// Theme: follows system preference unless user overrides via toggle
(function initTheme() {
  const saved = localStorage.getItem("bilhete-unico-theme");
  const toggle = document.getElementById("theme-toggle");

  function apply(theme) {
    if (theme) {
      document.documentElement.setAttribute("data-theme", theme);
    } else {
      document.documentElement.removeAttribute("data-theme");
    }
    const isDark =
      theme === "dark" ||
      (!theme && window.matchMedia("(prefers-color-scheme: dark)").matches);
    toggle.textContent = isDark ? "☀️" : "🌙";
  }

  apply(saved);

  toggle.addEventListener("click", () => {
    const current = document.documentElement.getAttribute("data-theme");
    const systemDark = window.matchMedia(
      "(prefers-color-scheme: dark)",
    ).matches;
    const effectiveDark = current === "dark" || (!current && systemDark);
    const next = effectiveDark ? "light" : "dark";
    localStorage.setItem("bilhete-unico-theme", next);
    apply(next);
  });
})();

const FARES = {
  bus: 5.3,
  rail: 5.4,
  integration: 9.38,
  temporal: {
    daily: { bus: 20.25, rail: 20.5, combined: 27.28 },
    weekly: { bus: 66.94 },
    monthly: { bus: 257.53, rail: 262.43, combined: 411.13 },
  },
  maxTripsPerDay: 10,
  weeksPerMonth: 4.35,
};

const WEEKEND_EXTRA_TRIPS = {
  never: 0,
  rarely: 2,
  sometimes: 8,
  often: 16,
};

const WEEKEND_LABELS = {
  never: "",
  rarely: "~2 viagens extras/mês",
  sometimes: "~8 viagens extras/mês (2 por fim de semana)",
  often: "~16 viagens extras/mês (4 por fim de semana)",
};

const STORAGE_KEY = "bilhete-unico-state";

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function saveState() {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      journeys,
      daysPerWeek,
      includesSunday,
      weekendLevel,
      customWeekendTrips,
    }),
  );
}

const saved = loadState();
let journeys = saved?.journeys ?? [];
let daysPerWeek = saved?.daysPerWeek ?? 5;
let includesSunday = saved?.includesSunday ?? false;
let weekendLevel = saved?.weekendLevel ?? "never";
let customWeekendTrips = saved?.customWeekendTrips ?? 0;

function calcJourneyBreakdown(steps) {
  const busSteps = steps.filter((l) => l === "bus").length;
  const railSteps = steps.filter((l) => l === "rail").length;

  if (busSteps === 0 && railSteps === 0) {
    return { cost: 0, integrated: false, info: null };
  }

  // Bilhete Único Comum: 1 bus fare covers up to 4 boardings on different lines within 3h
  if (busSteps > 0 && railSteps === 0) {
    const fares = Math.ceil(busSteps / 4);
    return {
      cost: fares * FARES.bus,
      integrated: false,
      info:
        busSteps > 1
          ? `${busSteps} ônibus em ${fares} tarifa${fares > 1 ? "s" : ""} (até 4 por tarifa na janela de 3h)`
          : null,
    };
  }

  if (busSteps === 0 && railSteps > 0) {
    return { cost: railSteps * FARES.rail, integrated: false, info: null };
  }

  // Integration fare (R$ 9.38) covers 1 rail + up to 3 buses within 3h.
  // Order doesn't matter — the system pairs them optimally across the window.
  // We maximize integrations to minimize total cost, then charge leftover
  // rails as standalone (R$ 5.40) and leftover buses at 4-per-fare (R$ 5.30).
  const integrationsNeeded = Math.min(railSteps, Math.ceil(busSteps / 3));
  const standaloneRail = railSteps - integrationsNeeded;
  const busCoveredByIntegration = integrationsNeeded * 3;
  const remainingBus = Math.max(0, busSteps - busCoveredByIntegration);
  const extraBusFareCount = Math.ceil(remainingBus / 4);
  const cost =
    integrationsNeeded * FARES.integration +
    standaloneRail * FARES.rail +
    extraBusFareCount * FARES.bus;
  const separateCost = busSteps * FARES.bus + railSteps * FARES.rail;

  const lines = [];
  let busPool = busSteps;
  for (let i = 0; i < integrationsNeeded; i++) {
    const busInThis = Math.min(3, busPool);
    busPool -= busInThis;
    lines.push(
      `1× integração — 1 trilho + ${busInThis} ônibus = R$ ${formatBRL(FARES.integration)}`,
    );
  }
  for (let i = 0; i < standaloneRail; i++) {
    lines.push(`1× trilho avulso = R$ ${formatBRL(FARES.rail)}`);
  }
  let busLeft = remainingBus;
  while (busLeft > 0) {
    const batch = Math.min(4, busLeft);
    lines.push(
      `1× tarifa ônibus (${batch} embarque${batch > 1 ? "s" : ""}) = R$ ${formatBRL(FARES.bus)}`,
    );
    busLeft -= batch;
  }
  lines.push(
    `Total: R$ ${formatBRL(cost)} (sem integração seria R$ ${formatBRL(separateCost)})`,
  );

  return {
    cost,
    integrated: true,
    info: lines.join("\n"),
  };
}

function calcJourneyCost(steps) {
  return calcJourneyBreakdown(steps).cost;
}

function getPassType(allSteps) {
  const hasBus = allSteps.some((l) => l === "bus");
  const hasRail = allSteps.some((l) => l === "rail");
  if (hasBus && hasRail) return "combined";
  if (hasRail) return "rail";
  return "bus";
}

function calcMonthlyOptions() {
  if (journeys.length === 0 || journeys.every((j) => j.steps.length === 0)) {
    return null;
  }

  const allSteps = journeys.flatMap((j) => j.steps);
  const totalTripsPerDay = allSteps.length;
  const passType = getPassType(allSteps);

  const dailyPerRide = journeys.reduce(
    (sum, j) => sum + calcJourneyCost(j.steps),
    0,
  );
  // Sundays: buses are free, only rail is charged
  const sundayDailyPerRide = journeys.reduce((sum, j) => {
    const railOnly = j.steps.filter((l) => l === "rail");
    return sum + calcJourneyCost(railOnly);
  }, 0);
  const paidDays = includesSunday ? daysPerWeek - 1 : daysPerWeek;
  const sundayDays = includesSunday ? 1 : 0;
  const monthlyPerRide =
    dailyPerRide * paidDays * FARES.weeksPerMonth +
    sundayDailyPerRide * sundayDays * FARES.weeksPerMonth;
  // Weekend extras only add cost to Avulso — temporal passes absorb them for free
  const extraTrips =
    weekendLevel === "custom"
      ? customWeekendTrips
      : WEEKEND_EXTRA_TRIPS[weekendLevel];
  const extraTripCost = extraTrips * FARES.bus;
  const monthlyPerRideWithExtras = monthlyPerRide + extraTripCost;

  const options = [
    {
      name: "Avulso",
      monthly: monthlyPerRideWithExtras,
      detail:
        extraTrips > 0
          ? `R$ ${formatBRL(dailyPerRide)}/dia + R$ ${formatBRL(extraTripCost)} extras`
          : `R$ ${formatBRL(dailyPerRide)}/dia`,
    },
  ];

  const temporalEligible = totalTripsPerDay <= FARES.maxTripsPerDay;
  const ineligibleWarning = `Excede o limite de ${FARES.maxTripsPerDay} viagens/dia`;

  const dailyPassPrice = FARES.temporal.daily[passType];
  if (dailyPassPrice) {
    options.push({
      name: "Diário (24h)",
      monthly: dailyPassPrice * daysPerWeek * FARES.weeksPerMonth,
      detail: `R$ ${formatBRL(dailyPassPrice)}/dia`,
      ineligible: !temporalEligible,
      warning: !temporalEligible ? ineligibleWarning : null,
    });
  }

  const weeklyBusOnly = passType === "bus";
  const weeklyPrice = FARES.temporal.weekly.bus;
  const weeklyIneligible = !temporalEligible || !weeklyBusOnly;
  const weeklyWarning = !temporalEligible
    ? ineligibleWarning
    : !weeklyBusOnly
      ? "Disponível apenas para uso exclusivo de ônibus"
      : null;
  options.push({
    name: "Semanal",
    monthly: weeklyPrice * FARES.weeksPerMonth,
    detail: `R$ ${formatBRL(weeklyPrice)}/semana`,
    ineligible: weeklyIneligible,
    warning: weeklyWarning,
  });

  const monthlyPassPrice = FARES.temporal.monthly[passType];
  if (monthlyPassPrice) {
    options.push({
      name: "Mensal",
      monthly: monthlyPassPrice,
      detail: "Passe de 31 dias corridos",
      ineligible: !temporalEligible,
      warning: !temporalEligible ? ineligibleWarning : null,
    });
  }

  return options;
}

function formatBRL(value) {
  return value.toFixed(2).replace(".", ",");
}

function render() {
  saveState();
  renderJourneys();
  renderResults();
}

function restoreUI() {
  document.querySelectorAll(".day-btn").forEach((b) => {
    b.classList.toggle("selected", parseInt(b.dataset.day) === daysPerWeek);
  });
  document.getElementById("sunday-check").checked = includesSunday;
  document.querySelectorAll(".weekend-btn").forEach((b) => {
    b.classList.toggle("selected", b.dataset.level === weekendLevel);
  });
  if (weekendLevel === "custom") {
    document.getElementById("weekend-custom").classList.remove("hidden");
    document.getElementById("weekend-custom-input").value = customWeekendTrips;
  }
  document.getElementById("weekend-detail").textContent =
    WEEKEND_LABELS[weekendLevel] || "";
}

function renderJourneys() {
  const container = document.getElementById("journeys-list");

  if (journeys.length === 0) {
    container.innerHTML =
      '<div class="empty-state">Adicione um trajeto para começar.</div>';
    return;
  }

  container.innerHTML = journeys
    .map((journey, ji) => {
      const breakdown = calcJourneyBreakdown(journey.steps);
      const stepsHTML = journey.steps
        .map((step, li) => {
          const arrow =
            li < journey.steps.length - 1
              ? '<span class="step-arrow">→</span>'
              : "";
          return `<span class="step-pill ${step}">${step === "bus" ? "Ônibus" : "Trilho"}<button class="remove-step" data-journey="${ji}" data-step="${li}">&times;</button></span>${arrow}`;
        })
        .join("");

      return `
      <div class="journey-card">
        <div class="journey-header">
          <div>
            <span class="journey-title">Trajeto ${ji + 1}</span>
            <span class="journey-cost"> — R$ ${formatBRL(breakdown.cost)}</span>
          </div>
          <button class="btn-remove" data-journey="${ji}">&times;</button>
        </div>
        <div class="add-steps">
          <button class="btn-step bus" data-journey="${ji}" data-type="bus">+ Ônibus</button>
          <button class="btn-step rail" data-journey="${ji}" data-type="rail">+ Trilho</button>
        </div>
        <div class="steps-container">${stepsHTML || '<span class="hint">Adicione ônibus ou trilho acima</span>'}</div>
        ${breakdown.info ? `<div class="journey-info">${breakdown.info}</div>` : ""}
      </div>
    `;
    })
    .join("");
}

function renderResults() {
  saveState();
  const section = document.getElementById("results-section");
  const container = document.getElementById("results-cards");
  const options = calcMonthlyOptions();

  if (!options) {
    section.classList.add("hidden");
    return;
  }

  section.classList.remove("hidden");

  const eligible = options.filter((o) => !o.ineligible);
  const minCost = Math.min(...eligible.map((o) => o.monthly));
  const maxCost = Math.max(...eligible.map((o) => o.monthly));

  container.innerHTML = options
    .map((option) => {
      const isCheapest = !option.ineligible && option.monthly === minCost;
      const savings = !option.ineligible && maxCost - option.monthly;
      const cardClass = option.ineligible
        ? "result-card ineligible"
        : isCheapest
          ? "result-card cheapest"
          : "result-card";
      return `
      <div class="${cardClass}">
        <div class="result-card-header">
          <span class="result-card-name">${option.name}</span>
          <span class="result-card-badge">Melhor opção</span>
        </div>
        <div class="result-card-price">R$ ${formatBRL(option.monthly)}</div>
        <div class="result-card-detail">${option.detail}</div>
        ${option.warning ? `<div class="result-card-warning">${option.warning}</div>` : ""}
        ${savings > 0 ? `<div class="result-card-savings">Economia de R$ ${formatBRL(savings)} vs. mais caro</div>` : ""}
      </div>
    `;
    })
    .join("");
}

document.getElementById("journeys-list").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-journey]");
  if (!btn) return;

  const ji = parseInt(btn.dataset.journey);

  if (btn.classList.contains("btn-remove")) {
    journeys = journeys.filter((_, i) => i !== ji);
    render();
    return;
  }

  if (btn.classList.contains("remove-step")) {
    const li = parseInt(btn.dataset.step);
    journeys = journeys.map((j, i) =>
      i === ji ? { ...j, steps: j.steps.filter((_, k) => k !== li) } : j,
    );
    render();
    return;
  }

  if (btn.dataset.type) {
    journeys = journeys.map((j, i) =>
      i === ji ? { ...j, steps: [...j.steps, btn.dataset.type] } : j,
    );
    render();
    return;
  }
});

document.getElementById("add-journey").addEventListener("click", () => {
  journeys = [...journeys, { steps: [] }];
  render();
});

document.getElementById("days-selector").addEventListener("click", (e) => {
  const btn = e.target.closest(".day-btn");
  if (!btn) return;

  daysPerWeek = parseInt(btn.dataset.day);
  document
    .querySelectorAll(".day-btn")
    .forEach((b) => b.classList.remove("selected"));
  btn.classList.add("selected");
  renderResults();
});

document.getElementById("sunday-check").addEventListener("change", (e) => {
  includesSunday = e.target.checked;
  renderResults();
});

document.getElementById("weekend-selector").addEventListener("click", (e) => {
  const btn = e.target.closest(".weekend-btn");
  if (!btn) return;

  weekendLevel = btn.dataset.level;
  document
    .querySelectorAll(".weekend-btn")
    .forEach((b) => b.classList.remove("selected"));
  btn.classList.add("selected");

  const customDiv = document.getElementById("weekend-custom");
  const detailP = document.getElementById("weekend-detail");
  if (weekendLevel === "custom") {
    customDiv.classList.remove("hidden");
    detailP.textContent = "";
  } else {
    customDiv.classList.add("hidden");
    detailP.textContent = WEEKEND_LABELS[weekendLevel];
  }
  renderResults();
});

document
  .getElementById("weekend-custom-input")
  .addEventListener("input", (e) => {
    customWeekendTrips = Math.max(0, parseInt(e.target.value) || 0);
    renderResults();
  });

restoreUI();
render();
