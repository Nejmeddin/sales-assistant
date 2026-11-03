import type { Channel } from "../lib/api";
import { Badge } from "./ui";

export function ChannelBadge({ channel }: { channel: Channel }) {
  return channel === "instagram" ? <Badge tone="pink">Instagram</Badge> : <Badge tone="blue">Messenger</Badge>;
}
