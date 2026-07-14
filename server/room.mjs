// Small, transport-independent room membership boundary.

export function detachRoomMember(team, clientId) {
  const previousLength = team.members.length;
  team.members = team.members.filter((id) => id !== clientId);
  if (team.picks) delete team.picks[clientId];

  const removed = team.members.length !== previousLength;
  let ownerChanged = false;
  if (removed && team.ownerId === clientId) {
    team.ownerId = team.members[0] ?? null;
    ownerChanged = true;
  }

  return {
    removed,
    ownerChanged,
    empty: team.members.length === 0,
  };
}
