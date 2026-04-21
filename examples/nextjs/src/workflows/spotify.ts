import { atom, input } from "@workflow/core";
import { getCurrentUser, spotify } from "@workflow/integrations-spotify";
import { z } from "zod";

// Minimal trigger so the user can start the run from the UI. The OAuth
// intervention fires automatically when `spotify` is first read.
export const spotifyProfileRequest = input(
  "spotifyProfileRequest",
  z.object({}),
  {
    title: "Read your Spotify profile",
    description:
      "Authorize Spotify and read the current user's profile via the Hylo broker.",
  },
);

const spotifyCurrentUser = getCurrentUser({
  auth: spotify,
  name: "spotifyCurrentUser",
});

export const spotifyProfile = atom(
  (get) => {
    const request = get.maybe(spotifyProfileRequest);
    if (!request) return get.skip("No Spotify profile request was submitted");

    const profile = get(spotifyCurrentUser);
    const auth = get(spotify);
    return {
      workflow: "spotify",
      action: "read-current-user-profile",
      spotifyUserId: profile.id,
      displayName: profile.displayName ?? profile.id,
      email: profile.email ?? undefined,
      country: profile.country,
      product: profile.product,
      followers: profile.followers,
      profileUrl: profile.profileUrl,
      grantedScopes: auth.scopes,
      tokenExpiresInSeconds: auth.expiresInSeconds,
    };
  },
  {
    name: "spotifyProfile",
    description: "Return the current Spotify user's profile.",
  },
);
