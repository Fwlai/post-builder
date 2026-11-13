const { createClient } = require("@supabase/supabase-js");

const url = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceRoleKey) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
}

const supabase = createClient(url, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false }
});

function ownerId(value) {
  const id = String(value || "");
  if (!/^\\d+$/.test(id)) throw new Error("Invalid Telegram owner ID.");
  return id;
}

async function listChannels(ownerUserId) {
  const { data, error } = await supabase
    .from("post_builder_channels")
    .select("id, owner_user_id, chat_id, username, title, created_at")
    .eq("owner_user_id", ownerId(ownerUserId))
    .order("created_at", { ascending: true });
  if (error) throw error;
  return data || [];
}

async function addChannel(ownerUserId, channel) {
  const record = {
    owner_user_id: ownerId(ownerUserId),
    chat_id: String(channel.chatId),
    username: channel.username || null,
    title: String(channel.title || channel.username || channel.chatId),
    updated_at: new Date().toISOString()
  };
  const { data, error } = await supabase
    .from("post_builder_channels")
    .upsert(record, { onConflict: "owner_user_id,chat_id" })
    .select("id, owner_user_id, chat_id, username, title, created_at")
    .single();
  if (error) throw error;
  return data;
}

async function deleteChannel(ownerUserId, channelId) {
  const { data, error } = await supabase
    .from("post_builder_channels")
    .delete()
    .eq("owner_user_id", ownerId(ownerUserId))
    .eq("id", channelId)
    .select("id")
    .maybeSingle();
  if (error) throw error;
  return Boolean(data);
}

async function getChannel(ownerUserId, channelId) {
  const { data, error } = await supabase
    .from("post_builder_channels")
    .select("id, owner_user_id, chat_id, username, title")
    .eq("owner_user_id", ownerId(ownerUserId))
    .eq("id", channelId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function loadDraft(ownerUserId) {
  const { data, error } = await supabase
    .from("post_builder_drafts")
    .select("draft_type, stage, payload, updated_at")
    .eq("owner_user_id", ownerId(ownerUserId))
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return { ...data.payload, type: data.draft_type, stage: data.stage };
}

async function saveDraft(ownerUserId, session) {
  const inferredType = session.type ||
    (String(session.stage || "").startsWith("album") ? "post2" :
      String(session.stage || "").startsWith("post3") ? "post3" : "post");
  const payload = { ...session };
  delete payload.type;
  delete payload.stage;
  const { error } = await supabase
    .from("post_builder_drafts")
    .upsert({
      owner_user_id: ownerId(ownerUserId),
      draft_type: inferredType,
      stage: session.stage,
      payload,
      updated_at: new Date().toISOString()
    }, { onConflict: "owner_user_id" });
  if (error) throw error;
}

async function deleteDraft(ownerUserId) {
  const { error } = await supabase
    .from("post_builder_drafts")
    .delete()
    .eq("owner_user_id", ownerId(ownerUserId));
  if (error) throw error;
}

module.exports = {
  listChannels,
  addChannel,
  deleteChannel,
  getChannel,
  loadDraft,
  saveDraft,
  deleteDraft
};
