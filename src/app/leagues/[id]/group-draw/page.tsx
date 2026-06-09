import { getScheduleSlots } from "@/lib/schedule/read";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ManagerNameplate } from "@/components/primitives/ManagerNameplate";

export default async function GroupDrawPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: leagueId } = await params;
  const { groups } = await getScheduleSlots(leagueId);

  if (groups.length === 0) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center px-4">
        <Card className="w-full max-w-sm text-center">
          <CardContent className="py-6">
            <p className="text-[var(--text-dim)]">Group draw has not been held yet.</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const slotsPerGroup = groups[0].slots.length;

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-[1400px] px-4 py-6 space-y-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Group Draw</h1>
          <p className="text-sm text-[var(--text-dim)] mt-0.5">
            {groups.length} groups · {slotsPerGroup} managers per group
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {groups.map((group) => (
            <Card key={group.groupLetter}>
              <CardHeader>
                <CardTitle>Group {group.groupLetter}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-1">
                {group.slots.map((slot) => (
                  <div
                    key={slot.slotCode}
                    className="flex items-center gap-3 min-h-[44px] px-1"
                  >
                    <span className="text-xs font-mono font-semibold text-[var(--text-dim)] w-7 shrink-0">
                      {slot.slotCode}
                    </span>
                    {slot.displayName ? (
                      <ManagerNameplate displayName={slot.displayName} size="sm" />
                    ) : (
                      <span className="text-sm text-[var(--text-dim)] italic">Unassigned</span>
                    )}
                  </div>
                ))}
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}
