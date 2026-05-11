export const BRAND_NAME = 'Interpreta';
export const SUITE_NAME = 'AI Analyst Suite';

export const PRODUCT_CODES = Object.freeze({
    REPORT_NARRATOR: 'REPORT_NARRATOR',
    DASHBOARD_NARRATOR: 'DASHBOARD_NARRATOR'
});

export const PRODUCT_NAMES = Object.freeze({
    [PRODUCT_CODES.REPORT_NARRATOR]: 'Report Narrator',
    [PRODUCT_CODES.DASHBOARD_NARRATOR]: 'Dashboard Narrator'
});

export const PRODUCT_OPERATIONS = Object.freeze({
    [PRODUCT_NAMES[PRODUCT_CODES.REPORT_NARRATOR]]: 'reportNarration',
    [PRODUCT_NAMES[PRODUCT_CODES.DASHBOARD_NARRATOR]]: 'dashboardNarration'
});

export const KNOWN_PRODUCT_NAMES = Object.freeze(Object.values(PRODUCT_NAMES));

export function isKnownProductName(productName) {
    return KNOWN_PRODUCT_NAMES.includes(productName);
}

export function assertKnownProductName(productName, context = 'product') {
    if (!isKnownProductName(productName)) {
        throw new Error(`Unsupported ${context}: ${productName}`);
    }
}

export function isValidOperationForProduct(productName, operation) {
    return PRODUCT_OPERATIONS[productName] === operation;
}

export function getKnownProductNames() {
    return [...KNOWN_PRODUCT_NAMES];
}
