// pt-BR number formatting (decimal comma), shared by the diagnosis texts and the UI.

export function formatNumber(value, decimals) {
  return value.toLocaleString('pt-BR', { minimumFractionDigits: decimals, maximumFractionDigits: decimals, useGrouping: false });
}

export function formatVolts(volts, decimals = 3) {
  return `${formatNumber(volts, decimals)} V`;
}

export function formatCelsius(celsius) {
  return `${formatNumber(celsius, 1)} °C`;
}

export function formatDate(isoDate) {
  const [year, month, day] = isoDate.split('-');
  return `${day}/${month}/${year}`;
}
