"""A fonte DEMO precisa ser deterministica e internamente consistente --
e' ela que sustenta o modo demo e os testes de ponta a ponta."""
import unittest
from datetime import datetime, timedelta

from src.sources.demo import DemoSource

AGORA = datetime(2026, 9, 15, 14, 30, 0)


def fonte(now=AGORA, seed=7):
    return DemoSource(seed=seed, now=now)


class DemoSourceTests(unittest.TestCase):
    def test_deterministica_para_mesma_semente_e_mesmo_instante(self):
        a = fonte().fetch_legs()
        b = fonte().fetch_legs()
        self.assertEqual(a, b)

    def test_sementes_diferentes_geram_operacoes_diferentes(self):
        self.assertNotEqual(fonte(seed=1).fetch_legs(), fonte(seed=2).fetch_legs())

    def test_etapa_nunca_regride_com_o_passar_do_tempo(self):
        ordem = ["Planejado", "Carregando", "Em Trânsito", "Em Descarregamento", "Concluído"]

        def etapas(now):
            troncal, secundaria = fonte(now).fetch_legs()
            return {(l["shipment_no"], l["base_destino_codigo"]): ordem.index(l["etapa"]) for l in troncal + secundaria}

        antes, depois = etapas(AGORA), etapas(AGORA + timedelta(hours=3))
        for chave, etapa in antes.items():
            self.assertLessEqual(etapa, depois[chave], chave)

    def test_resumo_de_carga_bate_com_a_lista_de_pacotes_carregados(self):
        f = fonte()
        troncal, secundaria = f.fetch_legs()
        embarcados = sorted({l["shipment_no"] for l in secundaria if l["etapa"] != "Planejado"})[:10]
        resumo = f.fetch_scan_summary(embarcados, "secundaria")
        carregados = f.fetch_loaded_parcels(embarcados, "secundaria")
        self.assertTrue(resumo)
        for sn, eventos in resumo.items():
            carga = next(e for e in eventos if e["direction"] == "load")
            self.assertEqual(carga["count"], len(carregados[sn]), sn)

    def test_pacote_voando_nao_esta_na_lista_de_carregados(self):
        f = fonte()
        _, secundaria = f.fetch_legs()
        alvo = sorted({l["shipment_no"] for l in secundaria if l["etapa"] == "Concluído"})[:5]
        carregados = f.fetch_loaded_parcels(alvo, "secundaria")
        descarregados = f.fetch_unloaded_parcels(alvo, "secundaria")
        voando = 0
        for sn in alvo:
            codigos = {p["bill_code"] for p in carregados[sn]}
            voando += sum(1 for p in descarregados[sn] if p["bill_code"] not in codigos)
        self.assertGreater(voando, 0)

    def test_taxas_so_para_dias_fechados(self):
        f = fonte()
        self.assertEqual(f.fetch_timely_rates(AGORA.date()), ([], []))
        linhas, falhas = f.fetch_timely_rates(AGORA.date() - timedelta(days=1))
        self.assertEqual(falhas, [])
        self.assertEqual({l["tipo"] for l in linhas}, {"sc_hub", "sc_sc", "hub_pdd"})
        for l in linhas:
            self.assertLessEqual(l["qtd_no_prazo"], l["qtd_total"])

    def test_tickets_em_aberto_respeitam_o_sla(self):
        f = fonte()
        for tipo in ("comum", "plataforma"):
            for t in f.fetch_open_tickets(tipo):
                self.assertEqual(t["prazo_limite"], t["data_registro"] + timedelta(hours=t["horas_sla"]))

    def test_pudo_e_c2c_respeitam_a_janela_e_o_relogio(self):
        f = fonte()
        inicio, fim = AGORA - timedelta(days=2), AGORA
        for l in f.fetch_pudo(inicio, fim):
            self.assertTrue(inicio <= l["enter_time"] <= fim)
        linhas, incompleto = f.fetch_c2c(inicio, fim)
        self.assertFalse(incompleto)
        for l in linhas:
            self.assertTrue(inicio <= l["input_time"] <= fim)


if __name__ == "__main__":
    unittest.main()
