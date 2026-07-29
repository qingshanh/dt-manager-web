import assert from "node:assert/strict";
import test from "node:test";
import { staticPhoneCountryOptions } from "../services/dingtone/direct-gateway.js";
import { assertPhoneCountrySelection } from "./accounts.js";

test("phone country guard accepts every static TalkU country exposed by the panel", () => {
  const countries = staticPhoneCountryOptions();
  assert.ok(countries.some((item) => item.countryKey === "BR"));

  for (const country of countries) {
    assert.doesNotThrow(() => assertPhoneCountrySelection({
      country_code: country.countryCode,
      iso_country_code: country.isoCountryCode,
      country_key: country.countryKey
    }));
  }
});

test("phone country guard still rejects ambiguous +1 country mismatches", () => {
  assert.throws(
    () => assertPhoneCountrySelection({ country_code: 1, iso_country_code: "US", country_key: "CA" }),
    /iso_country_code US does not match country_key CA/
  );
});
