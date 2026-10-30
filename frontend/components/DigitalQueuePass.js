import { QUEUE_PASS_HEIGHT, QUEUE_PASS_WIDTH, priorityLevelLabel, queuePassSvgContents } from "../lib/queueTicket";

export default function DigitalQueuePass({ ticket, svgRef }) {
  if (!ticket) return null;
  return (
    <svg
      ref={svgRef}
      className="digital-queue-pass"
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${QUEUE_PASS_WIDTH} ${QUEUE_PASS_HEIGHT}`}
      width={QUEUE_PASS_WIDTH}
      height={QUEUE_PASS_HEIGHT}
      role="img"
      aria-label={`Queue ${ticket.queueNumber}. ${ticket.serviceLabel}. ${ticket.doctorName}. Registered ${ticket.registeredDate}, ${ticket.registeredTime} Philippine time. ${ticket.statusLabel}.${ticket.isActive ? "" : " Inactive ticket; no new queue position."} ${priorityLevelLabel(ticket)} Saved snapshot; photos do not update.`}
      dangerouslySetInnerHTML={{ __html: queuePassSvgContents(ticket) }}
    />
  );
}
