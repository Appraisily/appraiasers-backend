const { 
  openaiService, 
  sheetsService, 
  emailService, 
  wordpressService 
} = require('../services');
const { config } = require('../config');

class UpdatePendingAppraisalController {
  static async updatePendingAppraisal(req, res) {
    try {
      const incomingSecret = req.headers['x-shared-secret'];
      if (incomingSecret !== config.SHARED_SECRET) {
        return res.status(403).json({ 
          success: false, 
          message: 'Forbidden: Invalid shared secret.' 
        });
      }

      const { 
        description, 
        images, 
        post_id, 
        post_edit_url, 
        customer_email, 
        session_id 
      } = req.body;

      if (!session_id || !customer_email || !post_id || !images?.main || !post_edit_url) {
        return res.status(400).json({ 
          success: false, 
          message: 'Missing required fields.' 
        });
      }

      // Send immediate response
      res.json({ 
        success: true, 
        message: 'Appraisal status update initiated.' 
      });

      // Process in background
      (async () => {
        try {
          let iaDescription = '';
          
          // Try to generate AI description if service is available
          if (openaiService.isAvailable) {
            try {
              iaDescription = await openaiService.generateDescription(images.main);
            } catch (error) {
              console.error('Failed to generate AI description:', error);
              iaDescription = 'AI description unavailable';
            }
          } else {
            iaDescription = 'AI service unavailable';
          }

          // Update WordPress title
          await wordpressService.updatePost(post_id, {
            title: iaDescription ? `Preliminary Analysis: ${iaDescription}` : 'Pending Analysis'
          });

          // Find row in sheets and update
          const values = await sheetsService.getValues(
            config.PENDING_APPRAISALS_SPREADSHEET_ID,
            `${config.GOOGLE_SHEET_NAME}!A:O`
          );

          let rowIndex = null;
          let customer_name = '';

          for (let i = 0; i < values.length; i++) {
            if (values[i][2] === session_id) {
              rowIndex = i + 1;
              customer_name = values[i][4] || '';
              break;
            }
          }

          if (!rowIndex) {
            throw new Error(`Session ID ${session_id} not found`);
          }

          // Update sheets with new data
          await Promise.all([
            sheetsService.updateValues(
              config.PENDING_APPRAISALS_SPREADSHEET_ID,
              `${config.GOOGLE_SHEET_NAME}!H${rowIndex}`,
              [[iaDescription]]
            ),
            sheetsService.updateValues(
              config.PENDING_APPRAISALS_SPREADSHEET_ID,
              `${config.GOOGLE_SHEET_NAME}!I${rowIndex}`,
              [[description || '']]
            ),
            sheetsService.updateValues(
              config.PENDING_APPRAISALS_SPREADSHEET_ID,
              `${config.GOOGLE_SHEET_NAME}!O${rowIndex}`,
              [[JSON.stringify(images)]]
            )
          ]);

          // Try to send email if service is available
          if (emailService.isAvailable) {
            try {
              await emailService.sendAppraisalUpdateEmail(
                customer_email,
                customer_name,
                description,
                iaDescription
              );
            } catch (error) {
              console.error('Failed to send email notification:', error);
            }
          }

        } catch (error) {
          console.error('Background processing error:', error);
        }
      })();

    } catch (error) {
      console.error('Error in updatePendingAppraisal:', error);
      if (!res.headersSent) {
        res.status(500).json({ 
          success: false, 
          message: 'Internal server error.' 
        });
      }
    }
  }
}

module.exports = UpdatePendingAppraisalController;