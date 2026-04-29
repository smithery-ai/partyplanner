import { atom } from "@workflow/core";
import { listEmails } from "@workflow/integrations-gmail";

export const gmailLastTenEmails = listEmails({
  nEmails: 10,
  actionName: "gmailLastTenEmails",
  authorizationTitle: "Authorize Gmail inbox access",
  authorizationDescription:
    "Open Arcade authorization and approve Gmail access so the workflow can read your latest emails.",
});

const gmailLatestEmailLimit = atom(
  (get) => {
    get(gmailLastTenEmails);
    return 1;
  },
  {
    name: "gmailLatestEmailLimit",
    description:
      "Wait for the ten-email fetch before starting the latest-email fetch.",
  },
);

export const gmailLatestEmail = listEmails({
  nEmails: gmailLatestEmailLimit,
  actionName: "gmailLatestEmail",
  authorizationTitle: "Authorize Gmail inbox access",
  authorizationDescription:
    "Open Arcade authorization and approve Gmail access so the workflow can read your latest email.",
});
