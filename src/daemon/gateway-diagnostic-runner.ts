import { getGatewayDiagnostic } from './pm2';

try {
    console.log(JSON.stringify(getGatewayDiagnostic()));
} catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
}
