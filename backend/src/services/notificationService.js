const env = require("../config/env");

/**
 * Sends SMS using Gatewayapi.com
 * @param {string} mobileNumber 
 * @param {string} message 
 */
async function sendSMS(mobileNumber, message) {
  if (!env.gatewayApiToken || !mobileNumber) {
    return false;
  }

  // Basic mobile number formatting for Philippines if it starts with 0
  let formattedNumber = mobileNumber.replace(/\D/g, "");
  if (formattedNumber.startsWith("0")) {
    formattedNumber = "63" + formattedNumber.slice(1);
  } else if (!formattedNumber.startsWith("63") && formattedNumber.length === 10) {
    formattedNumber = "63" + formattedNumber;
  }

  try {
    const response = await fetch("https://gatewayapi.com/rest/mtsms", {
      method: "POST",
      headers: {
        "Authorization": `Basic ${Buffer.from(env.gatewayApiToken + ":").toString("base64")}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        sender: env.smsSenderName || "QueueSys",
        message: message,
        recipients: [{ msisdn: parseInt(formattedNumber) }]
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("[sms] GatewayAPI failed:", errorText);
      return false;
    }

    return true;
  } catch (err) {
    console.error("[sms] Error sending SMS:", err.message);
    return false;
  }
}

async function sendQueueCreatedNotification(mobileNumber, queueNumber, serviceType, waitingCount) {
  const estimatedWaitMinutes = Math.max(1, waitingCount * 3);
  const body = [
    `Your Queue Number: ${queueNumber}`,
    `Service: ${serviceType}`,
    `Estimated waiting time: ${estimatedWaitMinutes} minutes`,
    `Other patients currently waiting: ${waitingCount}`
  ].join("\n");

  const results = [];
  if (mobileNumber) {
    results.push(sendSMS(mobileNumber, body));
  }

  return Promise.all(results);
}

async function sendQueueCalledNotification(mobileNumber, queueNumber, counterName) {
  const message = `Your queue number ${queueNumber} is now being called at counter ${counterName}. Please proceed immediately. You have 30 seconds to proceed.`;
  const results = [];

  if (mobileNumber) {
    results.push(sendSMS(mobileNumber, message));
  }

  return Promise.all(results);
}

module.exports = {
  sendSMS,
  sendQueueCreatedNotification,
  sendQueueCalledNotification
};
