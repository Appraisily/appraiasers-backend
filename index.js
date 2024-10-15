// index.js.

const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');
const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');
const { OAuth2Client } = require('google-auth-library');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const authorizedUsers = require('./authorizedUsers'); // Lista de usuarios autorizados
const fetch = require('node-fetch');
const app = express();
require('dotenv').config(); // Asegúrate de tener dotenv configurado

// CORS Configuration
const corsOptions = {
  origin: 'https://appraisers-frontend-856401495068.us-central1.run.app', // Tu URL frontend
  credentials: true, // Permitir credenciales (cookies)
  optionsSuccessStatus: 200
};
app.use(cors(corsOptions));

app.use(express.json());
app.use(cookieParser());

// Configurar cliente OAuth2 con tu Client ID
const oauthClient = new OAuth2Client('856401495068-ica4bncmu5t8i0muugrn9t8t25nt1hb4.apps.googleusercontent.com'); // Tu Client ID

const client = new SecretManagerServiceClient();

// **Función para Actualizar el Flag en ACF**
async function updateShortcodesFlag(wpPostId, authHeader) {
  try {
    const wpEndpoint = `${process.env.WORDPRESS_API_URL}/appraisals/${wpPostId}`;
    console.log(`[updateShortcodesFlag] Actualizando flag en ACF para el post ID: ${wpPostId}`);

    // Obtener el contenido actual del post para mantener otros campos
    const currentPostResponse = await fetch(wpEndpoint, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': authHeader
      }
    });

    if (!currentPostResponse.ok) {
      const errorText = await currentPostResponse.text();
      console.error(`[updateShortcodesFlag] Error obteniendo el post actual para actualizar ACF: ${errorText}`);
      throw new Error('Error obteniendo el post actual para actualizar ACF.');
    }

    const currentPostData = await currentPostResponse.json();
    const updatedACF = {
      ...currentPostData.acf,
      shortcodes_inserted: true // Asumiendo que el campo ACF es un booleano
    };

    // Actualizar el campo ACF en WordPress
    const updateACFResponse = await fetch(wpEndpoint, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': authHeader
      },
      body: JSON.stringify({
        acf: updatedACF
      })
    });

    if (!updateACFResponse.ok) {
      const errorText = await updateACFResponse.text();
      console.error(`[updateShortcodesFlag] Error actualizando ACF en WordPress: ${errorText}`);
      throw new Error('Error actualizando ACF en WordPress.');
    }

    console.log(`[updateShortcodesFlag] Flag 'shortcodes_inserted' actualizado a 'true' en WordPress.`);
  } catch (error) {
    console.error(`[updateShortcodesFlag] ${error.message}`);
    throw error; // Propagar el error para manejarlo en el caller
  }
}




// Función genérica para obtener un secreto
async function getSecret(secretName) {
  try {
    const projectId = await client.getProjectId();
    const name = `projects/${projectId}/secrets/${secretName}/versions/latest`;

    const [version] = await client.accessSecretVersion({ name });
    const payload = version.payload.data.toString('utf8');
    return payload;
  } catch (error) {
    console.error(`Error obteniendo el secreto ${secretName}:`, error);
    throw new Error(`No se pudo obtener el secreto ${secretName}`);
  }
}

// Configurar variables para secretos
let JWT_SECRET;

// Función para verificar el ID token
async function verifyIdToken(idToken) {
  const ticket = await oauthClient.verifyIdToken({
    idToken: idToken,
    audience: '856401495068-ica4bncmu5t8i0muugrn9t8t25nt1hb4.apps.googleusercontent.com', // Tu Client ID
  });

  const payload = ticket.getPayload();
  return payload;
}

// Middleware de autenticación y autorización usando JWT de la cookie
function authenticate(req, res, next) {
  const token = req.cookies.jwtToken;

  if (!token) {
    return res.status(401).json({ success: false, message: 'Unauthorized. Token not provided.' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded; // Almacena información del usuario en req.user

    // Verificar si el usuario está en la lista de autorizados
    if (!authorizedUsers.includes(decoded.email)) {
      return res.status(403).json({ success: false, message: 'Forbidden. You do not have access to this resource.' });
    }

    next();
  } catch (error) {
    console.error('Error verifying JWT:', error);
    res.status(401).json({ success: false, message: 'Invalid token.' });
  }
}

// Ruta de autenticación
app.post('/api/authenticate', async (req, res) => {
  const { idToken } = req.body;

  if (!idToken) {
    return res.status(400).json({ success: false, message: 'ID Token is required.' });
  }

  try {
    const payload = await verifyIdToken(idToken);
    console.log('Authenticated user:', payload.email);

    // Verificar si el usuario está en la lista de autorizados
    if (!authorizedUsers.includes(payload.email)) {
      return res.status(403).json({ success: false, message: 'Access denied: User not authorized.' });
    }

    // Generar tu propio JWT
    const token = jwt.sign(
      {
        email: payload.email,
        name: payload.name
      },
      JWT_SECRET,
      { expiresIn: '1h' } // Token válido por 1 hora
    );

    // Enviar el JWT como una cookie httpOnly
    res.cookie('jwtToken', token, {
      httpOnly: true,
      secure: true, // Asegúrate de que tu app use HTTPS
      sameSite: 'None', // 'None' para permitir cookies de sitios cruzados
      maxAge: 60 * 60 * 1000 // 1 hora
    });

    // Enviar el nombre del usuario en la respuesta
    res.json({ success: true, name: payload.name });
  } catch (error) {
    console.error('Error verifying ID Token:', error);
    res.status(401).json({ success: false, message: 'Authentication failed.' });
  }
});

// Ruta de logout
app.post('/api/logout', (req, res) => {
  res.clearCookie('jwtToken', {
    httpOnly: true,
    secure: true,
    sameSite: 'None'
  });
  res.json({ success: true, message: 'Successfully logged out.' });
});

// Función para inicializar la API de Google Sheets
async function initializeSheets() {
  try {
    console.log('Accediendo al secreto de la cuenta de servicio...');
    const serviceAccount = await getSecret('service-account-json');
    console.log('Secreto de la cuenta de servicio accedido exitosamente.');

    const auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(serviceAccount),
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    const sheets = google.sheets({ version: 'v4', auth });
    console.log('Autenticado con la API de Google Sheets');
    return sheets;
  } catch (error) {
    console.error('Error autenticando con la API de Google Sheets:', error);
    throw error; // Propagar el error para evitar el inicio del servidor
  }
}

// Función para obtener la URL de la imagen
const getImageUrl = async (imageField) => {
  if (!imageField) return null;

  // Si es un número o una cadena que representa un número (ID de imagen)
  if (typeof imageField === 'number' || (typeof imageField === 'string' && /^\d+$/.test(imageField))) {
    const mediaId = imageField;
    try {
      const mediaResponse = await fetch(`https://www.appraisily.com/wp-json/wp/v2/media/${mediaId}`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json'
        }
      });
      if (!mediaResponse.ok) {
        console.error(`Error fetching image with ID ${mediaId}:`, await mediaResponse.text());
        return null;
      }
      const mediaData = await mediaResponse.json();
      return mediaData.source_url || null;
    } catch (error) {
      console.error(`Error fetching image with ID ${mediaId}:`, error);
      return null;
    }
  }

  // Si es una URL directa
  if (typeof imageField === 'string' && imageField.startsWith('http')) {
    return imageField;
  }

  // Si es un objeto con una propiedad 'url'
  if (typeof imageField === 'object' && imageField.url) {
    return imageField.url;
  }

  return null;
};

// Función para iniciar el servidor
async function startServer() {
  try {
    // Obtener secretos antes de iniciar el servidor
    JWT_SECRET = await getSecret('jwt-secret');
    console.log('JWT_SECRET obtenido exitosamente.');

    const sheets = await initializeSheets();

    // Recuperar credenciales de WordPress desde Secret Manager
    const WORDPRESS_USERNAME = (await getSecret('wp_username')).trim();
    const WORDPRESS_APP_PASSWORD = (await getSecret('wp_app_password')).trim();
    const WORDPRESS_API_URL = (await getSecret('WORDPRESS_API_URL')).trim();

    // Asignar las credenciales y URL a variables de entorno
    process.env.WORDPRESS_USERNAME = WORDPRESS_USERNAME;
    process.env.WORDPRESS_APP_PASSWORD = WORDPRESS_APP_PASSWORD;
    process.env.WORDPRESS_API_URL = WORDPRESS_API_URL;

    console.log('WORDPRESS_USERNAME:', process.env.WORDPRESS_USERNAME);
    console.log('WORDPRESS_APP_PASSWORD:', process.env.WORDPRESS_APP_PASSWORD ? 'Loaded' : 'Not Loaded');
    console.log('WORDPRESS_API_URL cargado correctamente:', process.env.WORDPRESS_API_URL);

    // Recuperar credenciales de SendGrid desde Secret Manager
    const SENDGRID_API_KEY = (await getSecret('SENDGRID_API_KEY')).trim();
    const SENDGRID_EMAIL = (await getSecret('SENDGRID_EMAIL')).trim();

    // Asignar las credenciales a variables de entorno
    process.env.SENDGRID_API_KEY = SENDGRID_API_KEY;
    process.env.SENDGRID_EMAIL = SENDGRID_EMAIL;

    console.log('SENDGRID_API_KEY y SENDGRID_EMAIL cargados correctamente.');

    // Tu ID de Google Sheet
    const SPREADSHEET_ID = '1PDdt-tEV78uMGW-813UTcVxC9uzrRXQSmNLCI1rR-xc';
    const SHEET_NAME = 'Pending Appraisals';

    // **Endpoint: Obtener Apreciaciones Pendientes**
    app.get('/api/appraisals', authenticate, async (req, res) => {
      try {
        const response = await sheets.spreadsheets.values.get({
          spreadsheetId: SPREADSHEET_ID,
          range: `${SHEET_NAME}!A2:H`, // Ajusta el rango según tus columnas
        });

        const rows = response.data.values || [];
        console.log(`Total de filas obtenidas: ${rows.length}`);

        const appraisals = rows.map((row, index) => ({
          id: index + 2, // Número de fila en la hoja (A2 corresponde a id=2)
          date: row[0] || '', // Columna A: Fecha
          appraisalType: row[1] || '', // Columna B: Tipo de Apreciación
          identifier: row[2] || '', // Columna C: Número de Apreciación
          status: row[5] || '', // Columna F: Estado
          wordpressUrl: row[6] || '', // Columna G: URL de WordPress
          iaDescription: row[7] || '' // Columna H: Descripción de AI
        }));

        console.log(`Total de apreciaciones mapeadas: ${appraisals.length}`);
        res.json(appraisals);
      } catch (error) {
        console.error('Error obteniendo apreciaciones:', error);
        res.status(500).json({ success: false, message: 'Error obteniendo apreciaciones.' });
      }
    });

    // **Endpoint: Obtener Detalles de una Apreciación Específica**
    app.get('/api/appraisals/:id/list', authenticate, async (req, res) => {
      const { id } = req.params; // Número de fila

      try {
        // Actualizar el rango para incluir la columna I
        const response = await sheets.spreadsheets.values.get({
          spreadsheetId: SPREADSHEET_ID,
          range: `${SHEET_NAME}!A${id}:I${id}`, // Ahora incluye hasta la columna I
        });

        const row = response.data.values ? response.data.values[0] : null;

        if (!row) {
          return res.status(404).json({ success: false, message: 'Apreciación no encontrada.' });
        }

        // Incluir descripción del cliente (columna I)
        const appraisal = {
          id: id,
          date: row[0] || '',
          appraisalType: row[1] || '',
          identifier: row[2] || '',
          status: row[5] || '',
          wordpressUrl: row[6] || '',
          iaDescription: row[7] || '',
          customerDescription: row[8] || '' // Nueva propiedad
        };

        // Extraer el post ID de la URL de WordPress
        const wordpressUrl = appraisal.wordpressUrl;
        const parsedUrl = new URL(wordpressUrl);
        const postId = parsedUrl.searchParams.get('post');

        if (!postId) {
          return res.status(400).json({ success: false, message: 'No se pudo extraer el ID del post de WordPress.' });
        }

        console.log(`[api/appraisals/${id}] Post ID extraído: ${postId}`);

        // Construir el endpoint para obtener el post
        const wpEndpoint = `${process.env.WORDPRESS_API_URL}/appraisals/${postId}`;
        console.log(`[api/appraisals/${id}] Endpoint de WordPress: ${wpEndpoint}`);

        // Realizar la solicitud a la API REST de WordPress
        const wpResponse = await fetch(wpEndpoint, {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Basic ${Buffer.from(`${encodeURIComponent(process.env.WORDPRESS_USERNAME)}:${process.env.WORDPRESS_APP_PASSWORD.trim()}`).toString('base64')}`
          }
        });

        if (!wpResponse.ok) {
          const errorText = await wpResponse.text();
          console.error(`[api/appraisals/${id}] Error obteniendo post de WordPress: ${errorText}`);
          return res.status(500).json({ success: false, message: 'Error obteniendo datos de WordPress.' });
        }

        const wpData = await wpResponse.json();
        console.log(`[api/appraisals/${id}] Datos de WordPress obtenidos:`, wpData);

        // Obtener los campos ACF
        const acfFields = wpData.acf || {};

        // Obtener URLs de imágenes
        const images = {
          main: await getImageUrl(acfFields.main),
          age: await getImageUrl(acfFields.age),
          signature: await getImageUrl(acfFields.signature)
        };

        // Agregar imágenes a la respuesta
        appraisal.images = images;

        // Enviar la respuesta con la descripción del cliente incluida
        res.json(appraisal);
      } catch (error) {
        console.error('Error obteniendo detalles de la apreciación:', error);
        res.status(500).json({ success: false, message: 'Error obteniendo detalles de la apreciación.' });
      }
    });

    // **Endpoint: Save PDF and Doc Links in Google Sheets**
app.post('/api/appraisals/:id/save-links', authenticate, async (req, res) => {
  const { id } = req.params; // Número de fila en Google Sheets
  const { pdfLink, docLink } = req.body;

  // Validación de los datos recibidos
  if (!pdfLink || !docLink) {
    return res.status(400).json({ success: false, message: 'PDF Link y Doc Link son requeridos.' });
  }

  try {
    // Actualizar las columnas M y N en Google Sheets
    const updateRange = `${SHEET_NAME}!M${id}:N${id}`; // Columnas M y N
    const values = [[pdfLink, docLink]];

    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: updateRange,
      valueInputOption: 'RAW',
      resource: {
        values: values,
      },
    });

    console.log(`[save-links] Actualizadas las columnas M y N para la fila ${id} con PDF Link: ${pdfLink} y Doc Link: ${docLink}`);

    res.json({ success: true, message: 'PDF Link y Doc Link guardados exitosamente en Google Sheets.' });
  } catch (error) {
    console.error('Error guardando los links en Google Sheets:', error);
    res.status(500).json({ success: false, message: 'Error guardando los links en Google Sheets.' });
  }
});


// **Endpoint: Obtener Apreciaciones Completadas**
app.get('/api/appraisals/completed', authenticate, async (req, res) => {
  try {
    const sheetName = 'Completed Appraisals'; // Asegúrate de que este es el nombre correcto de la hoja
    const range = `${sheetName}!A2:H`; // Definición correcta del rango
    console.log(`Fetching completed appraisals with range: ${range}`);
    
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: range, // Usar la variable 'range' definida arriba
    });

    const rows = response.data.values || [];
    console.log(`Total de filas obtenidas (Completadas): ${rows.length}`);

    // Verificar si 'rows' es un arreglo
    if (!Array.isArray(rows)) {
      console.error('La respuesta de Google Sheets no es un arreglo:', rows);
      throw new Error('La respuesta de Google Sheets no es un arreglo.');
    }

    // Loguear cada fila para depuración
    rows.forEach((row, index) => {
      console.log(`Fila ${index + 2}:`, row);
    });

    const completedAppraisals = rows.map((row, index) => ({
      id: index + 2, // Número de fila en la hoja (A2 corresponde a id=2)
      date: row[0] || '', // Columna A: Fecha
      appraisalType: row[1] || '', // Columna B: Tipo de Apreciación
      identifier: row[2] || '', // Columna C: Número de Apreciación
      status: row[5] || '', // Columna F: Estado
      wordpressUrl: row[6] || '', // Columna G: URL de WordPress
      iaDescription: row[7] || '' // Columna H: Descripción de AI
    }));

    console.log(`Total de apreciaciones completadas mapeadas: ${completedAppraisals.length}`);
    res.json(completedAppraisals);
  } catch (error) {
    console.error('Error obteniendo apreciaciones completadas:', error);
    res.status(500).json({ success: false, message: 'Error obteniendo apreciaciones completadas.' });
  }
});




    
// **Endpoint: Obtener session_ID a partir de postId**
app.post('/api/appraisals/get-session-id', authenticate, async (req, res) => {
  const { postId } = req.body;

  if (!postId) {
    return res.status(400).json({ success: false, message: 'postId es requerido.' });
  }

  try {
    // Construir el endpoint de WordPress para obtener el post
    const wpEndpoint = `${process.env.WORDPRESS_API_URL}/appraisals/${postId}`;
    console.log(`[get-session-id] Endpoint de WordPress: ${wpEndpoint}`);

    // Realizar la solicitud GET a la API REST de WordPress
    const wpResponse = await fetch(wpEndpoint, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${Buffer.from(`${encodeURIComponent(process.env.WORDPRESS_USERNAME)}:${process.env.WORDPRESS_APP_PASSWORD.trim()}`).toString('base64')}`
      }
    });

    if (!wpResponse.ok) {
      const errorText = await wpResponse.text();
      console.error(`[get-session-id] Error obteniendo post de WordPress: ${errorText}`);
      return res.status(500).json({ success: false, message: 'Error obteniendo datos de WordPress.' });
    }

    const wpData = await wpResponse.json();
    const acfFields = wpData.acf || {};
    const session_ID = acfFields.session_id || '';

    if (!session_ID) {
      console.error(`[get-session-id] session_ID no encontrado en el post de WordPress.`);
      return res.status(404).json({ success: false, message: 'session_ID no encontrado en el post de WordPress.' });
    }

    console.log(`[get-session-id] session_ID extraído: ${session_ID}`);
    res.json({ success: true, session_ID });
  } catch (error) {
    console.error('Error obteniendo session_ID:', error);
    res.status(500).json({ success: false, message: 'Error obteniendo session_ID.' });
  }
});


    // **Endpoint: Set Appraisal Value**
app.post('/api/appraisals/:id/set-value', authenticate, async (req, res) => {
  const { id } = req.params; // Número de fila en Google Sheets
  const { appraisalValue, description } = req.body;

  // Validación de los datos recibidos
  if (appraisalValue === undefined || description === undefined) {
    return res.status(400).json({ success: false, message: 'Appraisal Value y descripción son requeridos.' });
  }

  try {
    // Actualizar las columnas J y K en Google Sheets
    const updateRange = `${SHEET_NAME}!J${id}:K${id}`;
    const values = [[appraisalValue, description]];

    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: updateRange,
      valueInputOption: 'RAW',
      resource: {
        values: values,
      },
    });

    console.log(`[set-value] Actualizadas las columnas J y K para la fila ${id} con Appraisal Value: ${appraisalValue} y Descripción: ${description}`);

    // Obtener detalles de la apreciación para obtener la URL de WordPress
    const appraisalResponse = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A${id}:I${id}`,
    });

    const appraisalRow = appraisalResponse.data.values ? appraisalResponse.data.values[0] : null;

    if (!appraisalRow) {
      return res.status(404).json({ success: false, message: 'Apreciación no encontrada para actualizar en WordPress.' });
    }

    const appraisalWordpressUrl = appraisalRow[6] || ''; // Columna G: WordPress URL

    if (!appraisalWordpressUrl) {
      return res.status(400).json({ success: false, message: 'URL de WordPress no proporcionada.' });
    }

    const parsedWpUrl = new URL(appraisalWordpressUrl);
    const wpPostId = parsedWpUrl.searchParams.get('post');

    if (!wpPostId) {
      return res.status(400).json({ success: false, message: 'No se pudo extraer el ID del post de WordPress.' });
    }

    console.log(`[set-value] Post ID extraído: ${wpPostId}`);

    // **Actualizar el Campo ACF 'value' en WordPress**

    // Construir el endpoint de actualización
    const updateWpEndpoint = `${process.env.WORDPRESS_API_URL}/appraisals/${wpPostId}`;
    console.log(`[set-value] Endpoint de actualización de WordPress: ${updateWpEndpoint}`);

    // Preparar los datos para actualizar el campo ACF
    const updateData = {
      acf: {
        value: appraisalValue // Asegúrate de que 'value' es el nombre correcto del campo ACF
      }
    };

    // Construir el encabezado de autenticación
    const credentialsString = `${encodeURIComponent(process.env.WORDPRESS_USERNAME)}:${process.env.WORDPRESS_APP_PASSWORD.trim()}`;
    const base64Credentials = Buffer.from(credentialsString).toString('base64');
    const authHeader = 'Basic ' + base64Credentials;
    console.log(`[set-value] Autenticación configurada.`);

    // Realizar la solicitud de actualización a WordPress
    const wpUpdateResponse = await fetch(updateWpEndpoint, {
      method: 'PUT', // Puedes cambiar a 'PATCH' si prefieres actualizar parcialmente
      headers: {
        'Content-Type': 'application/json',
        'Authorization': authHeader
      },
      body: JSON.stringify(updateData)
    });

    if (!wpUpdateResponse.ok) {
      const errorText = await wpUpdateResponse.text();
      console.error(`[set-value] Error actualizando WordPress: ${errorText}`);
      throw new Error('Error actualizando el campo ACF en WordPress.');
    }

    const wpUpdateData = await wpUpdateResponse.json();
    console.log(`[set-value] WordPress actualizado exitosamente:`, wpUpdateData);

    // Responder al frontend
    res.json({ success: true, message: 'Appraisal Value y descripción actualizados exitosamente en Google Sheets y WordPress.' });
  } catch (error) {
    console.error('Error en el endpoint set-value:', error);
    res.status(500).json({ success: false, message: 'Error actualizando Appraisal Value y descripción.' });
  }
});



    

// **Endpoint: Completar Apreciación**
app.post('/api/appraisals/:id/complete', authenticate, async (req, res) => {
  const { id } = req.params; // Número de fila
  const { appraisalValue, description } = req.body;

  if (appraisalValue === undefined || description === undefined) {
    return res.status(400).json({ success: false, message: 'Se requieren valor de apreciación y descripción.' });
  }

  try {
    // Actualizar las columnas J y K con los datos proporcionados
    const updateRange = `${SHEET_NAME}!J${id}:K${id}`;
    const values = [[appraisalValue, description]];

    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: updateRange,
      valueInputOption: 'RAW',
      resource: {
        values: values,
      },
    });

    // Actualizar el estado de la apreciación a "Completed" en la columna F
    const statusUpdateRange = `${SHEET_NAME}!F${id}:F${id}`;
    const statusValues = [['Completed']];

    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: statusUpdateRange,
      valueInputOption: 'RAW',
      resource: {
        values: statusValues,
      },
    });

    // **Actualizar el Campo ACF en WordPress**

    // Obtener detalles de la apreciación para obtener la URL de WordPress
    const appraisalResponse = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A${id}:I${id}`,
    });

    const appraisalRow = appraisalResponse.data.values ? appraisalResponse.data.values[0] : null;

    if (!appraisalRow) {
      return res.status(404).json({ success: false, message: 'Apreciación no encontrada para actualizar en WordPress.' });
    }

    const appraisalWordpressUrl = appraisalRow[6] || ''; // Columna G: WordPress URL

    if (!appraisalWordpressUrl) {
      return res.status(400).json({ success: false, message: 'URL de WordPress no proporcionada.' });
    }

    const parsedWpUrl = new URL(appraisalWordpressUrl);
    const wpPostId = parsedWpUrl.searchParams.get('post');

    if (!wpPostId) {
      return res.status(400).json({ success: false, message: 'No se pudo extraer el ID del post de WordPress.' });
    }

    console.log(`[api/appraisals/${id}/complete] Post ID extraído: ${wpPostId}`);

    // **Actualizar el Campo ACF 'value' en WordPress**

    // Construir el endpoint de actualización
    const updateWpEndpoint = `${process.env.WORDPRESS_API_URL}/appraisals/${wpPostId}`;
    console.log(`[api/appraisals/${id}/complete] Endpoint de actualización de WordPress: ${updateWpEndpoint}`);

    // Preparar los datos para actualizar el campo ACF
    const updateData = {
      acf: {
        value: appraisalValue // Asegúrate de que 'value' es el nombre correcto del campo ACF
      }
    };

    // Construir el encabezado de autenticación
    const credentialsString = `${encodeURIComponent(process.env.WORDPRESS_USERNAME)}:${process.env.WORDPRESS_APP_PASSWORD.trim()}`; // Asegúrate de que no haya espacios adicionales
    const base64Credentials = Buffer.from(credentialsString).toString('base64');
    const authHeader = 'Basic ' + base64Credentials;
    console.log(`[api/appraisals/${id}/complete] Autenticación configurada.`);

    // Realizar la solicitud de actualización a WordPress
    const wpUpdateResponse = await fetch(updateWpEndpoint, {
      method: 'PUT', // Puedes cambiar a 'PATCH' si prefieres actualizar parcialmente
      headers: {
        'Content-Type': 'application/json',
        'Authorization': authHeader
      },
      body: JSON.stringify(updateData)
    });

    if (!wpUpdateResponse.ok) {
      const errorText = await wpUpdateResponse.text();
      console.error(`[api/appraisals/${id}/complete] Error actualizando WordPress: ${errorText}`);
      return res.status(500).json({ success: false, message: 'Error actualizando WordPress.' });
    }

    const wpUpdateData = await wpUpdateResponse.json();
    console.log(`[api/appraisals/${id}/complete] WordPress actualizado exitosamente:`, wpUpdateData);

    // Responder al frontend
    res.json({ success: true, message: 'Apreciación completada exitosamente y actualizada en WordPress.' });
  } catch (error) {
    console.error('Error completando la apreciación:', error);
    res.status(500).json({ success: false, message: 'Error completando la apreciación.' });
  }
});

// **Endpoint: Merge Descriptions with OpenAI**
app.post('/api/appraisals/:id/merge-descriptions', authenticate, async (req, res) => {
  const { id } = req.params;
  const { appraiserDescription, iaDescription } = req.body;

  // Validación de las descripciones recibidas
  if (!appraiserDescription || !iaDescription) {
    return res.status(400).json({ success: false, message: 'Appraiser description and IA description are required.' });
  }

  // Obtener la clave de OpenAI desde las variables de entorno
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

  if (!OPENAI_API_KEY) {
    console.error('OPENAI_API_KEY is not defined in environment variables.');
    return res.status(500).json({ success: false, message: 'Server configuration error. Please contact support.' });
  }

  try {
    // Preparar la solicitud a OpenAI GPT-4 Chat API
    const openAIEndpoint = 'https://api.openai.com/v1/chat/completions';

    const openAIRequestBody = {
      model: 'gpt-4', // Utiliza el modelo de chat GPT-4
      messages: [
        {
          role: 'system',
          content: 'You are an assistant that merges appraiser and AI descriptions into a cohesive paragraph.'
        },
        {
          role: 'user',
          content: `Appraiser Description: ${appraiserDescription}\nAI Description: ${iaDescription}\n\nPlease merge the above descriptions into a cohesive paragraph.`
        }
      ],
      max_tokens: 150,
      temperature: 0.7
    };

    // Realizar llamada a OpenAI GPT-4 Chat API
    const openAIResponse = await fetch(openAIEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}` // Usar la clave de OpenAI desde las variables de entorno
      },
      body: JSON.stringify(openAIRequestBody)
    });

    // Manejo de errores de la respuesta de OpenAI
    if (!openAIResponse.ok) {
      const errorDetails = await openAIResponse.text();
      console.error('Error response from OpenAI:', errorDetails);
      throw new Error('Error merging descriptions with OpenAI.');
    }

    const openAIData = await openAIResponse.json();

    // Validar la estructura de la respuesta de OpenAI
    if (!openAIData.choices || !openAIData.choices[0].message || !openAIData.choices[0].message.content) {
      throw new Error('Invalid response structure from OpenAI.');
    }

    const blendedDescription = openAIData.choices[0].message.content.trim();

    console.log('Blended Description:', blendedDescription);

    // **Nuevo: Actualizar la columna L con blendedDescription**
    const updateRange = `${SHEET_NAME}!L${id}:L${id}`; // Columna L
    const updateValues = [[blendedDescription]];

    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: updateRange,
      valueInputOption: 'RAW',
      resource: {
        values: updateValues,
      },
    });

    console.log(`[merge-descriptions] Actualizada columna L para la fila ${id} con blendedDescription.`);

    // Responder al frontend con la descripción unificada
    res.json({ success: true, blendedDescription });
  } catch (error) {
    console.error('Error merging descriptions with OpenAI:', error);
    res.status(500).json({ success: false, message: 'Error merging descriptions with OpenAI.' });
  }
});

    
// **Endpoint: Insert Shortcodes in WordPress Post**
app.post('/api/appraisals/:id/insert-template', authenticate, async (req, res) => {
  const { id } = req.params;
  
  console.log(`\n[insert-template] Iniciando proceso para la apreciación ID: ${id}`);

  try {
    // Definir el mapeo de 'type' a 'template_id'
    const typeToTemplateIdMap = {
      'RegularArt': 114984, // Reemplaza con el template_id real para RegularArt
      'PremiumArt': 137078, // Ejemplo de otro tipo
      // Agrega más tipos según sea necesario
    };

    // Obtener detalles de la apreciación para obtener la URL de WordPress y el Type
    const appraisalResponse = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A${id}:K${id}`, // Columnas A (URL), B (Type), K (Template ID)
    });

    console.log(`[insert-template] Respuesta de Google Sheets:`, appraisalResponse.data.values);

    const appraisalRow = appraisalResponse.data.values ? appraisalResponse.data.values[0] : null;

    if (!appraisalRow) {
      console.error(`[insert-template] Apreciación ID ${id} no encontrada en Google Sheets.`);
      return res.status(404).json({ success: false, message: 'Apreciación no encontrada para insertar shortcodes en WordPress.' });
    }

   
// **Extraer la URL de WordPress desde la columna G (índice 6)**
const wordpressUrl = appraisalRow[6]?.trim() || ''; // Columna G: WordPress URL
console.log(`[insert-template] WordPress URL extraída: ${wordpressUrl}`);


    // Extraer el type desde la columna B (índice 1)
    let appraisalType = appraisalRow[1] || 'RegularArt'; // Columna B: Appraisal Type, por defecto 'RegularArt'
    appraisalType = appraisalType.trim();
    console.log(`[insert-template] Appraisal Type extraído: ${appraisalType}`);

    // Determinar el template_id basado en el type
    const templateId = typeToTemplateIdMap[appraisalType] || typeToTemplateIdMap['RegularArt'];
    console.log(`[insert-template] Template ID determinado: ${templateId}`);

    // Parsear la URL de WordPress para obtener el Post ID
    let wpPostId = '';

    try {
      const parsedUrl = new URL(wordpressUrl);
      wpPostId = parsedUrl.searchParams.get('post');
      console.log(`[insert-template] Post ID extraído: ${wpPostId}`);
    } catch (error) {
      console.error(`[insert-template] Error al parsear la URL de WordPress: ${error}`);
      return res.status(400).json({ success: false, message: 'URL de WordPress inválida.' });
    }

    if (!wpPostId || isNaN(wpPostId)) {
      console.error(`[insert-template] Post ID de WordPress no proporcionado o inválido en la URL.`);
      return res.status(400).json({ success: false, message: 'Post ID de WordPress no proporcionado o inválido.' });
    }

    // **Obtener las Credenciales de WordPress desde Secret Manager**
    const wpUsername = process.env.WORDPRESS_USERNAME;
    const wpAppPassword = process.env.WORDPRESS_APP_PASSWORD;

    console.log(`[insert-template] Credenciales de WordPress obtenidas: Username=${wpUsername ? 'Loaded' : 'Not Loaded'}, App Password=${wpAppPassword ? 'Loaded' : 'Not Loaded'}`);

    if (!wpUsername || !wpAppPassword) {
      console.error('Credenciales de WordPress faltantes.');
      return res.status(500).json({ success: false, message: 'Error de configuración del servidor. Por favor, contacta con soporte.' });
    }

    // **Definir el Shortcode a Insertar**
    const shortcodesToInsert = `[pdf_download]\n[AppraisalTemplates type="${appraisalType}"]`; // Usar type en lugar de template_id
    console.log(`[insert-template] Shortcodes a insertar: ${shortcodesToInsert}`);

    // **Construir el Endpoint de Actualización del Post**
    const updateWpEndpoint = `${process.env.WORDPRESS_API_URL}/appraisals/${wpPostId}`;
    console.log(`[insert-template] Endpoint de actualización construido: ${updateWpEndpoint}`);

    // **Configurar la Autenticación Básica**
    const credentialsString = `${encodeURIComponent(wpUsername)}:${wpAppPassword.trim()}`; // Asegúrate de que no haya espacios adicionales
    const base64Credentials = Buffer.from(credentialsString).toString('base64');
    const authHeader = 'Basic ' + base64Credentials;
    console.log(`[insert-template] Autenticación configurada.`);

    // **Obtener el Contenido Actual del Post**
    console.log(`[insert-template] Realizando solicitud GET al endpoint de WordPress para obtener el contenido actual.`);
    const currentPostResponse = await fetch(updateWpEndpoint, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': authHeader
      }
    });

    if (!currentPostResponse.ok) {
      const errorText = await currentPostResponse.text();
      console.error(`[insert-template] Error obteniendo el post actual de WordPress: ${errorText}`);
      throw new Error('Error obteniendo el post actual de WordPress.');
    }

    const currentPostData = await currentPostResponse.json();
    console.log(`[insert-template] Contenido actual del post obtenido:`, currentPostData);

    // **Verificar si los Shortcodes ya existen en el contenido**
    const currentContent = currentPostData.content.rendered;
    const hasPdfDownload = currentContent.includes('[pdf_download]');
    const hasAppraisalTemplate = currentContent.includes(`[AppraisalTemplates type="${appraisalType}"]`) || currentContent.includes(`[AppraisalTemplates type=${appraisalType}]`);

    // **Verificar el Flag en ACF**
    const acfFields = currentPostData.acf || {};
    const shortcodesInserted = acfFields.shortcodes_inserted || false;

    if (shortcodesInserted) {
      console.log(`[insert-template] Shortcodes ya han sido insertados previamente según el flag en ACF. No se realizarán cambios.`);
      return res.json({ success: true, message: 'Shortcodes ya han sido insertados previamente en el post de WordPress.' });
    }

    if (hasPdfDownload && hasAppraisalTemplate) {
      console.log(`[insert-template] Los shortcodes ya existen en el post de WordPress. No se realizarán cambios.`);
      // **Actualizar el Flag en ACF a 'true'**
      await updateShortcodesFlag(wpPostId, authHeader);
      return res.json({ success: true, message: 'Shortcodes ya existen en el post de WordPress.' });
    }

    // **Combinar el Contenido Actual con los Shortcodes si no existen**
    let updatedContent = currentContent;

    if (!hasPdfDownload) {
      updatedContent += '\n[pdf_download]';
      console.log(`[insert-template] Shortcode [pdf_download] añadido al contenido.`);
    }

    if (!hasAppraisalTemplate) {
      updatedContent += `\n[AppraisalTemplates type="${appraisalType}"]`;
      console.log(`[insert-template] Shortcode [AppraisalTemplates type="${appraisalType}"] añadido al contenido.`);
    }

    console.log(`[insert-template] Contenido actualizado del post:`, updatedContent);

    // **Actualizar el Post con los Shortcodes**
    console.log(`[insert-template] Realizando solicitud PUT al endpoint de WordPress para actualizar el contenido.`);
    const updatePostResponse = await fetch(updateWpEndpoint, {
      method: 'PUT', // Puedes cambiar a 'PATCH' si prefieres actualizar parcialmente
      headers: {
        'Content-Type': 'application/json',
        'Authorization': authHeader
      },
      body: JSON.stringify({
        content: updatedContent
      })
    });

    if (!updatePostResponse.ok) {
      const errorText = await updatePostResponse.text();
      console.error(`[insert-template] Error insertando shortcodes en WordPress: ${errorText}`);
      throw new Error('Error insertando shortcodes en WordPress.');
    }

    console.log(`[insert-template] Shortcodes insertados exitosamente en el post de WordPress.`);

    // **Actualizar el Flag en ACF a 'true'**
    await updateShortcodesFlag(wpPostId, authHeader);

    res.json({ success: true, message: 'Shortcodes insertados exitosamente en el post de WordPress.' });
  } catch (error) {
    console.error('Error insertando shortcodes en WordPress:', error);
    res.status(500).json({ success: false, message: 'Error insertando shortcodes en WordPress.' });
  }
});


    

// **Función para actualizar el flag en ACF**
async function updateShortcodesFlag(wpPostId, authHeader) {
  const updateWpEndpoint = `${process.env.WORDPRESS_API_URL}/appraisals/${wpPostId}`;
  console.log(`[updateShortcodesFlag] Actualizando el flag en ACF a 'true' en el post ID: ${wpPostId}`);

  const updateFlagResponse = await fetch(updateWpEndpoint, {
    method: 'PUT', // Método correcto para actualizar
    headers: {
      'Content-Type': 'application/json',
      'Authorization': authHeader
    },
    body: JSON.stringify({
      acf: {
        shortcodes_inserted: true
      }
    })
  });

  if (!updateFlagResponse.ok) {
    const errorText = await updateFlagResponse.text();
    console.error(`[updateShortcodesFlag] Error actualizando el flag en ACF: ${errorText}`);
    throw new Error('Error actualizando el flag en ACF.');
  }

  const updateFlagData = await updateFlagResponse.json();
  console.log(`[updateShortcodesFlag] Flag en ACF actualizado exitosamente:`, updateFlagData);
}
    

// **Endpoint: Send Email to Customer**
app.post('/api/appraisals/:id/send-email', authenticate, async (req, res) => {
  const { id } = req.params;
  const { templateId } = req.body; // Receive templateId from the request body

  console.log(`[send-email] Endpoint called for appraisal ID: ${id}`);

  try {
    // Get appraisal details from Google Sheets
    const appraisalResponse = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A${id}:N${id}`, // Include columns up to N to get PDF link
    });

    const appraisalRow = appraisalResponse.data.values ? appraisalResponse.data.values[0] : null;

    if (!appraisalRow) {
      console.warn(`[send-email] Appraisal ID ${id} not found.`);
      return res.status(404).json({ success: false, message: 'Appraisal not found for sending email.' });
    }

    const customerEmail = appraisalRow[3]?.trim() || ''; // Column D: Customer Email
    console.log(`[send-email] Customer email obtained: ${customerEmail}`);

    if (!customerEmail) {
      console.warn(`[send-email] Customer email not provided for appraisal ID ${id}.`);
      return res.status(400).json({ success: false, message: 'Customer email not provided.' });
    }

    // Validate the customer's email format
    const isValidEmail = (email) => {
      const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      return re.test(String(email).toLowerCase());
    };

    if (!isValidEmail(customerEmail)) {
      console.warn(`[send-email] Invalid email format: ${customerEmail}`);
      return res.status(400).json({ success: false, message: 'Invalid customer email format.' });
    }

    // Get the WordPress edit URL from Google Sheets
    const wordpressEditUrl = appraisalRow[6]?.trim() || ''; // Column G: WordPress URL (edit link)

    if (!wordpressEditUrl) {
      console.error(`[send-email] WordPress URL not provided in Google Sheets.`);
      return res.status(400).json({ success: false, message: 'WordPress URL not provided.' });
    }

    // Extract wpPostId from the WordPress edit URL
    let wpPostId = '';
    try {
      const parsedWpUrl = new URL(wordpressEditUrl);
      wpPostId = parsedWpUrl.searchParams.get('post');
      console.log(`[send-email] wpPostId extracted: ${wpPostId}`);
    } catch (error) {
      console.error(`[send-email] Error parsing WordPress URL: ${error}`);
      return res.status(400).json({ success: false, message: 'Invalid WordPress URL.' });
    }

    if (!wpPostId) {
      console.error(`[send-email] Could not extract WordPress post ID.`);
      return res.status(400).json({ success: false, message: 'Could not extract WordPress post ID.' });
    }

    // Obtain the public URL of the post from the WordPress REST API
    const wpEndpoint = `${process.env.WORDPRESS_API_URL}/appraisals/${wpPostId}`;
    console.log(`[send-email] WordPress API endpoint: ${wpEndpoint}`);

    // Configure authentication
    const credentialsString = `${encodeURIComponent(process.env.WORDPRESS_USERNAME)}:${process.env.WORDPRESS_APP_PASSWORD.trim()}`;
    const base64Credentials = Buffer.from(credentialsString).toString('base64');
    const authHeader = 'Basic ' + base64Credentials;

    // Fetch post data from WordPress
    const wpResponse = await fetch(wpEndpoint, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': authHeader
      }
    });

    if (!wpResponse.ok) {
      const errorText = await wpResponse.text();
      console.error(`[send-email] Error fetching post from WordPress: ${errorText}`);
      return res.status(500).json({ success: false, message: 'Error fetching post from WordPress.' });
    }

    const wpData = await wpResponse.json();

    // Get the public URL of the post
    const publicUrl = wpData.link;
    console.log(`[send-email] Public URL of the post: ${publicUrl}`);

    if (!publicUrl) {
      console.error(`[send-email] Public URL not found in WordPress post data.`);
      return res.status(500).json({ success: false, message: 'Public URL not found in WordPress post data.' });
    }

    // Get the PDF link from Google Sheets
    const pdfLink = appraisalRow[12]?.trim() || ''; // Column M: PDF Link

    // **Construct the customer dashboard link**
    const customerDashboardLink = `https://www.appraisily.com/dashboard/?email=${encodeURIComponent(customerEmail)}`;

    // Get SendGrid credentials from environment variables
    const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
    const SENDGRID_EMAIL = process.env.SENDGRID_EMAIL;

    if (!SENDGRID_API_KEY || !SENDGRID_EMAIL) {
      console.error('Missing SendGrid credentials.');
      return res.status(500).json({ success: false, message: 'Server configuration error. Please contact support.' });
    }

    if (!templateId) {
      console.error('No SendGrid template ID provided.');
      return res.status(400).json({ success: false, message: 'SendGrid template ID is required.' });
    }

    console.log(`[send-email] Sending email to: ${customerEmail} using template ID: ${templateId}`);

    // Send Email using SendGrid with the template
    const sendGridResponse = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SENDGRID_API_KEY}`
      },
      body: JSON.stringify({
        personalizations: [{
          to: [{ email: customerEmail }],
          dynamic_template_data: {
            appraisal_link: publicUrl,
            pdf_link: pdfLink,
            dashboard_link: customerDashboardLink,
            // Include other dynamic data as needed
          },
        }],
        from: { email: SENDGRID_EMAIL, name: 'Appraisily' },
        template_id: templateId
      })
    });

    if (!sendGridResponse.ok) {
      const errorText = await sendGridResponse.text();
      console.error(`[send-email] Error sending email via SendGrid: ${errorText}`);
      return res.status(500).json({ success: false, message: 'Error sending email to customer.' });
    }

    console.log(`[send-email] Email successfully sent to: ${customerEmail}`);
    res.json({ success: true, message: 'Email sent to customer successfully.' });
  } catch (error) {
    console.error(`[send-email] Error sending email to customer:`, error);
    res.status(500).json({ success: false, message: 'Error sending email to customer.' });
  }
});




// **Endpoint: Update Post Title in WordPress**
app.post('/api/appraisals/:id/update-title', authenticate, async (req, res) => {
  const { id } = req.params;
  const { newTitle } = req.body;

  if (!newTitle) {
    return res.status(400).json({ success: false, message: 'New title is required.' });
  }

  try {
    // Obtener detalles de la apreciación para obtener la URL de WordPress
    const appraisalResponse = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A${id}:I${id}`,
    });

    const appraisalRow = appraisalResponse.data.values ? appraisalResponse.data.values[0] : null;

    if (!appraisalRow) {
      return res.status(404).json({ success: false, message: 'Appraisal not found for updating in WordPress.' });
    }

    const appraisalWordpressUrl = appraisalRow[6] || ''; // Columna G: WordPress URL

    if (!appraisalWordpressUrl) {
      return res.status(400).json({ success: false, message: 'WordPress URL not provided.' });
    }

    const parsedWpUrl = new URL(appraisalWordpressUrl);
    const wpPostId = parsedWpUrl.searchParams.get('post');

    if (!wpPostId) {
      return res.status(400).json({ success: false, message: 'Could not extract WordPress post ID.' });
    }

    console.log(`[api/appraisals/${id}/update-title] Post ID extraído: ${wpPostId}`);

    // **Actualizar el Título del Post en WordPress**
    const updateWpEndpoint = `${process.env.WORDPRESS_API_URL}/appraisals/${wpPostId}`;
    console.log(`[api/appraisals/${id}/update-title] Endpoint de actualización de WordPress: ${updateWpEndpoint}`);

    const updateData = {
      title: newTitle
    };

    // Construir el encabezado de autenticación
    const credentialsString = `${encodeURIComponent(process.env.WORDPRESS_USERNAME)}:${process.env.WORDPRESS_APP_PASSWORD.trim()}`;
    const base64Credentials = Buffer.from(credentialsString).toString('base64');
    const authHeader = 'Basic ' + base64Credentials;

    console.log(`[api/appraisals/${id}/update-title] Autenticación configurada: ${authHeader ? 'Yes' : 'No'}`);

    // Realizar la solicitud PUT a WordPress
    console.log(`[api/appraisals/${id}/update-title] Realizando solicitud PUT al endpoint de WordPress: ${updateWpEndpoint}`);
    const wpUpdateResponse = await fetch(updateWpEndpoint, {
      method: 'PUT', // Método correcto para actualizar
      headers: {
        'Content-Type': 'application/json',
        'Authorization': authHeader
      },
      body: JSON.stringify(updateData)
    });

    if (!wpUpdateResponse.ok) {
      const errorText = await wpUpdateResponse.text();
      console.error(`[api/appraisals/${id}/update-title] Error actualizando WordPress: ${errorText}`);
      throw new Error('Error updating WordPress post title.');
    }

    const wpUpdateData = await wpUpdateResponse.json();
    console.log(`[api/appraisals/${id}/update-title] WordPress actualizado exitosamente:`, wpUpdateData);

    res.json({ success: true, message: 'WordPress post title updated successfully.' });
  } catch (error) {
    console.error('Error updating post title in WordPress:', error);
    res.status(500).json({ success: false, message: 'Error updating post title in WordPress.' });
  }
});

// Iniciar el Servidor en Todas las Interfaces (ya existente)

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor backend corriendo en el puerto ${PORT}`);
});
} catch (error) {
  console.error('Error iniciando el servidor:', error);
  process.exit(1); // Salir si hay un error de inicialización
}
}

startServer();
