// The connected-account presets: services whose OAuth (or key) grant lives in the
// Connect registry and whose REST/GraphQL API the Api tool then drives with
// curated operations. One file per service in this folder; this file is the roster.
//
// Importing this module registers every preset's definition with @ares/core, so
// `Api services` lists them and the safety model can resolve them. A file that
// exports null is a service not authored yet and is skipped.

import { apiConnectService, registerApiPresets, registerConnectService } from "@ares/core";
import type { PresetBundle } from "./_kit.js";

import vercel from "./vercel.js";
import github from "./github.js";
import google from "./google.js";
import microsoftGraph from "./microsoft-graph.js";
import slack from "./slack.js";
import notion from "./notion.js";
import linear from "./linear.js";
import atlassian from "./atlassian.js";
import spotify from "./spotify.js";
import dropbox from "./dropbox.js";
import figma from "./figma.js";
import asana from "./asana.js";
import todoist from "./todoist.js";
import trello from "./trello.js";
import stripe from "./stripe.js";
import shopify from "./shopify.js";
import cloudflare from "./cloudflare.js";
import supabase from "./supabase.js";
import sentry from "./sentry.js";
import pagerduty from "./pagerduty.js";
import strava from "./strava.js";
import fitbit from "./fitbit.js";
import zoom from "./zoom.js";
import reddit from "./reddit.js";
import twitch from "./twitch.js";
import metaGraph from "./meta-graph.js";
import airtable from "./airtable.js";
import hubspot from "./hubspot.js";
import calendly from "./calendly.js";
import mailchimp from "./mailchimp.js";
import discord from "./discord.js";
import linkedin from "./linkedin.js";
import typeform from "./typeform.js";
import x from "./x.js";
import xero from "./xero.js";
import salesforce from "./salesforce.js";

/** Every service the roster names, in the order `services` lists them. */
export const PRESET_ROSTER: string[] = ["vercel", "github", "google", "microsoft-graph", "slack", "notion", "linear", "atlassian", "spotify", "dropbox", "figma", "asana", "todoist", "trello", "stripe", "shopify", "cloudflare", "supabase", "sentry", "pagerduty", "strava", "fitbit", "zoom", "reddit", "twitch", "meta-graph", "airtable", "hubspot", "calendly", "mailchimp", "discord", "linkedin", "typeform", "x", "xero", "salesforce"];

const AUTHORED: Array<PresetBundle | null> = [vercel, github, google, microsoftGraph, slack, notion, linear, atlassian, spotify, dropbox, figma, asana, todoist, trello, stripe, shopify, cloudflare, supabase, sentry, pagerduty, strava, fitbit, zoom, reddit, twitch, metaGraph, airtable, hubspot, calendly, mailchimp, discord, linkedin, typeform, x, xero, salesforce];

export const PRESET_BUNDLES: PresetBundle[] = AUTHORED.filter((b): b is PresetBundle => b !== null);

const byId = new Map(PRESET_BUNDLES.map((b) => [b.id, b]));

export function presetBundle(id: string): PresetBundle | undefined {
  return byId.get(id);
}

registerApiPresets(PRESET_BUNDLES.map((b) => b.def));
// A preset with no registry OAuth collects its key (and address) on the standard `api-<id>` form.
for (const bundle of PRESET_BUNDLES) {
  const card = apiConnectService(bundle.def);
  if (card) registerConnectService(card);
}
