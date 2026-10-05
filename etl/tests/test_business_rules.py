"""Regras de negocio puras (sem banco, sem rede).

Rodar de dentro de etl/:  python -m unittest discover -s tests -v
"""
import unittest
from datetime import datetime, timedelta

from src.common.utils import derivar_etapa, normalizar_texto
from src.services import status as st
from src.services.carga_processado import calcular_linhas_agregadas
from src.services.responsavel import definir_responsavel

T0 = datetime(2026, 9, 1, 10, 0, 0)


class EtapaTests(unittest.TestCase):
    def test_progressao_de_etapas(self):
        self.assertEqual(derivar_etapa(None, None, None, None), "Planejado")
        self.assertEqual(derivar_etapa(T0, None, None, None), "Carregando")
        self.assertEqual(derivar_etapa(T0, None, T0, None), "Em Trânsito")
        self.assertEqual(derivar_etapa(T0, T0, T0, None), "Em Descarregamento")
        self.assertEqual(derivar_etapa(T0, T0, T0, T0), "Concluído")

    def test_chegada_sozinha_basta_para_concluido(self):
        # a fonte as vezes nao devolve o deslacre de paradas intermediarias
        self.assertEqual(derivar_etapa(None, None, None, T0), "Concluído")

    def test_normalizar_texto(self):
        self.assertEqual(normalizar_texto("  São   José  dos Pinhais "), "SAO JOSE DOS PINHAIS")
        self.assertEqual(normalizar_texto(None), "")


class ResponsavelTests(unittest.TestCase):
    def test_regra_das_6_horas(self):
        prazo = T0 + timedelta(hours=6)
        self.assertEqual(definir_responsavel(prazo - timedelta(minutes=1), prazo), "base anterior")
        self.assertEqual(definir_responsavel(prazo, prazo), "base anterior")
        self.assertEqual(definir_responsavel(prazo + timedelta(minutes=1), prazo), "base atual")

    def test_sem_registro_ou_sem_prazo(self):
        self.assertIsNone(definir_responsavel(None, T0))
        self.assertIsNone(definir_responsavel(T0, None))


class StatusTests(unittest.TestCase):
    def _carregado(self):
        return {"bill_code": "B1", "origin_code": "O", "next_station_code": "D", "scanned_at": T0}

    def test_chegou_vira_recebido(self):
        r = st.definir_status(self._carregado(), T0 + timedelta(hours=1))
        self.assertEqual(r["status"], "Recebido")
        self.assertIsNone(r["candidato_desde"])
        self.assertEqual(r["latest_scan_time"], T0 + timedelta(hours=1))

    def test_nao_chegou_vira_candidato_desde_o_carregamento(self):
        r = st.definir_status(self._carregado(), None)
        self.assertEqual(r["status"], "Candidato a Expedido não chegou")
        self.assertEqual(r["candidato_desde"], T0)

    def test_auditoria_nao_decide_o_status(self):
        auditoria = {"is_abnormal": True, "reason": "x", "registered_at": T0, "registered_site_code": "S"}
        r = st.definir_status(self._carregado(), None, auditoria)
        self.assertEqual(r["status"], "Candidato a Expedido não chegou")
        self.assertTrue(r["is_abnormal"])
        self.assertEqual(r["motivo_confirmado_lms"], "x")

    def test_pacote_voando(self):
        r = st.definir_pacote_voando({"bill_code": "F1", "scanned_at": T0}, "D")
        self.assertEqual(r["status"], "Pacote Voando")
        self.assertIsNone(r["network_code_esperado"])

    def test_candidatos_perto_do_prazo(self):
        agora = datetime.now()
        pacotes = [
            {"bill_code": "A", "status": "Candidato a Expedido não chegou"},
            {"bill_code": "B", "status": "Candidato a Expedido não chegou"},
            {"bill_code": "C", "status": "Recebido"},
        ]
        prazos = {"A": agora + timedelta(minutes=30), "B": agora + timedelta(hours=5), "C": agora}
        urgentes = st.candidatos_perto_do_prazo(pacotes, prazos)
        self.assertEqual([c["bill_code"] for c in urgentes], ["A"])


class CargaProcessadoTests(unittest.TestCase):
    PERNAS = {
        ("SH1", "secundaria", "D1"): {"etapa": "Concluído"},
        ("SH1", "secundaria", "D2"): {"etapa": "Em Descarregamento"},
        ("SH1", "secundaria", "D3"): {"etapa": "Planejado"},
    }

    def _eventos(self, descarregado_d2):
        return {"SH1": [
            {"direction": "load", "site_code": "O", "site_name": "O", "count": 100,
             "only_loaded": 40, "only_unloaded": None},
            {"direction": "unload", "site_code": "D1", "site_name": "D1", "count": 60,
             "only_loaded": None, "only_unloaded": 0},
            {"direction": "unload", "site_code": "D2", "site_name": "D2", "count": descarregado_d2,
             "only_loaded": None, "only_unloaded": 5},
        ]}

    def _por_destino(self, linhas):
        return {l["base_destino_codigo"]: l for l in linhas}

    def test_carga_vale_para_o_caminhao_inteiro_e_descarga_casa_pela_parada(self):
        linhas = self._por_destino(calcular_linhas_agregadas(self._eventos(30), self.PERNAS, set()))
        self.assertEqual(linhas["D1"]["carga_total"], 100)
        self.assertEqual(linhas["D2"]["carga_total"], 100)
        self.assertEqual(linhas["D1"]["qtd_processada"], 60)
        self.assertEqual(linhas["D2"]["qtd_processada"], 30)

    def test_parada_planejada_nao_recebe_contagem(self):
        linhas = self._por_destino(calcular_linhas_agregadas(self._eventos(30), self.PERNAS, set()))
        self.assertNotIn("D3", linhas)

    def test_processado_nao_e_limitado_pela_carga(self):
        """Regressao: descarregado > carregado ("pacote voando") deve aparecer
        com o numero REAL. Um min(processado, carga) escondia a escala do
        problema; o limite de 100% e' so' visual, na barra do frontend."""
        linhas = self._por_destino(calcular_linhas_agregadas(self._eventos(232), self.PERNAS, set()))
        self.assertEqual(linhas["D2"]["carga_total"], 100)
        self.assertEqual(linhas["D2"]["qtd_processada"], 232)

    def test_tipo_da_perna(self):
        eventos = self._eventos(30)
        linhas = calcular_linhas_agregadas(eventos, self.PERNAS, {"SH1"})
        # SH1 marcado como troncal -> nao ha' pernas troncais elegiveis -> nada gravado
        self.assertEqual(linhas, [])


if __name__ == "__main__":
    unittest.main()
