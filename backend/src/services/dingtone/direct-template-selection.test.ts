import assert from "node:assert/strict";
import test from "node:test";

import {
  hasDirectEmailActivationTemplateForVariant,
} from "./direct-template.js";

test("requires a Dingdong-specific email activation template when the Dingdong variant is selected", () => {
  const settings = {
    dt_direct_template_register_email: "legacy-template",
    dt_direct_template_register_email_talku: "talku-template",
    dt_direct_template_register_email_dingdong: "",
  };

  assert.equal(
    hasDirectEmailActivationTemplateForVariant(settings, "dt_direct_template_register_email", "dingdong"),
    false,
  );
});

test("accepts the matching TalkU-specific email activation template for TalkU accounts", () => {
  const settings = {
    dt_direct_template_register_email: "legacy-template",
    dt_direct_template_register_email_talku: "talku-template",
    dt_direct_template_register_email_dingdong: "",
  };

  assert.equal(
    hasDirectEmailActivationTemplateForVariant(settings, "dt_direct_template_register_email", "dingtone"),
    true,
  );
});
